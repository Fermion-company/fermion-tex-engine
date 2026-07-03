-- daemon.lua — the in-TeX side of the checkpoint engine.
--
-- The engine process never restarts. Every block boundary is frozen as a
-- fork()ed process (copy-on-write snapshot of the COMPLETE TeX state:
-- catcodes, macros, fonts, counters, label table, everything). An edit kills
-- the stale suffix of the checkpoint chain and resumes typesetting from the
-- last valid snapshot — so the visible cost of a keystroke is one paragraph
-- of Knuth-Plass plus IPC.
--
-- Per job child:
--   1. typeset the block into \box\TDOMgalley (main vertical list untouched,
--      PDF backend stays virgin so descendants can still ship pages)
--   2. walk the node lists and report a glyph-precise galley (positions from
--      node.effective_glue — exactly what would have been shipped)
--   3. become the next checkpoint and wait for further commands
--
-- Render children (for TikZ/pdf-literal blocks) chdir into a job directory,
-- \shipout the galley and finalize a real PDF, then exit.

local fk = nil
local sock = nil
local conn = nil
local PORT = 0
local WORKDIR = ''
local COUNTERS = {}
local CKPT = 0
local JOB = nil -- set in a freshly forked job child
local seen_fonts = {}
local blk_labels = {}
local blk_refs = {}
local blk_counters = {}
local blk_gfx = false

local SP2BP = 65781.76
local function bp(sp) return math.floor(((sp or 0) / SP2BP) * 1000 + 0.5) / 1000 end

-- ---------------------------------------------------------------- json

local function jstr(s)
  s = tostring(s)
  s = s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', ''):gsub('\t', '\\t')
  s = s:gsub('[%z\1-\31]', '')
  return '"' .. s .. '"'
end

local function jenc(v)
  local t = type(v)
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return '0' end
    return string.format('%.10g', v)
  elseif t == 'boolean' then
    return tostring(v)
  elseif t == 'string' then
    return jstr(v)
  elseif t == 'table' then
    if v[1] ~= nil or next(v) == nil then
      local parts = {}
      for i = 1, #v do parts[#parts + 1] = jenc(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    else
      local parts = {}
      for k, val in pairs(v) do parts[#parts + 1] = jstr(k) .. ':' .. jenc(val) end
      return '{' .. table.concat(parts, ',') .. '}'
    end
  end
  return 'null'
end

-- ---------------------------------------------------------------- boot

function tdom_boot(port, workdir, counters)
  PORT = port
  WORKDIR = workdir
  COUNTERS = counters
  local shim, lerr = package.loadlib(workdir .. '/tdomfork.so', 'luaopen_tdomfork')
  if not shim then
    texio.write_nl('tdom: FATAL cannot load fork shim: ' .. tostring(lerr))
    os.exit(1)
  end
  fk = shim()
  fk.ignore_sigchld()
  sock = require('socket')
  conn = assert(sock.connect('127.0.0.1', PORT))
  conn:setoption('tcp-nodelay', true)
  conn:send('HELLO ckpt 0 ' .. fk.getpid() .. '\n')
  texio.write_nl('tdom: daemon resident, checkpoint 0, pid ' .. fk.getpid())
end

function tdom_geo()
  local function dim(name)
    local ok, v = pcall(function() return tex.dimen[name] end)
    return ok and bp(v or 0) or 0
  end
  local payload = jenc({
    paperwidth = dim('paperwidth'),
    paperheight = dim('paperheight'),
    textwidth = dim('textwidth'),
    textheight = dim('textheight'),
    oddsidemargin = dim('oddsidemargin'),
    topmargin = dim('topmargin'),
    headheight = dim('headheight'),
    headsep = dim('headsep'),
    baselineskip = bp(tex.baselineskip.width or 0),
    lineskip = bp(tex.lineskip.width or 0),
    parskip = bp(tex.parskip.width or 0),
    parindent = bp(tex.parindent or 0),
  })
  conn:send('GEO ' .. #payload .. '\n')
  conn:send(payload)
end

-- Measure the unicode twin math font so the orchestrator can align legacy
-- cmex glyph ink exactly (TeX extents vs twin extents).
function tdom_twin_metrics(fid)
  local f = font.getfont(fid)
  if not f or not f.characters then return end
  local parts = {}
  for cp, ch in pairs(f.characters) do
    local h = bp(ch.height or 0)
    local d = bp(ch.depth or 0)
    if h ~= 0 or d ~= 0 then
      parts[#parts + 1] = '"' .. tostring(cp) .. '":[' .. h .. ',' .. d .. ']'
    end
  end
  local payload = '{' .. table.concat(parts, ',') .. '}'
  conn:send('TWIN ' .. #payload .. '\n')
  conn:send(payload)
end

local function reconnect(role, idx)
  -- a forked child must not speak on the inherited descriptor
  if conn then conn:close() end
  conn = assert(sock.connect('127.0.0.1', PORT))
  conn:setoption('tcp-nodelay', true)
  conn:send('HELLO ' .. role .. ' ' .. idx .. ' ' .. fk.getpid() .. '\n')
end

-- ---------------------------------------------------------------- shims

function tdom_label(key, value)
  blk_labels[#blk_labels + 1] = { k = key, v = value }
  -- Define the label LIVE in this process lineage: \label only writes to the
  -- aux (which a resident engine never re-reads), so \r@<key> must be set
  -- here for in-chain \ref resolution to track edits.
  pcall(function()
    token.set_macro('r@' .. key, '{' .. value .. '}{1}', 'global')
  end)
end

function tdom_ref(key)
  blk_refs[#blk_refs + 1] = key
end

function tdom_counter(name, value)
  blk_counters[name] = tonumber(value) or 0
end

-- ------------------------------------------------------- galley walking

local GLYPH = node.id('glyph')
local HLIST = node.id('hlist')
local VLIST = node.id('vlist')
local RULE = node.id('rule')
local GLUE = node.id('glue')
local KERN = node.id('kern')
local PENALTY = node.id('penalty')
local DISC = node.id('disc')
local WHATSIT = node.id('whatsit')

local LIT_SUB = node.subtype and node.subtype('pdf_literal')
local COL_SUB = node.subtype and node.subtype('pdf_colorstack')

local function note_font(fid)
  if fid and fid > 0 and not seen_fonts[fid] then
    local f = font.getfont(fid) or {}
    seen_fonts[fid] = {
      file = f.filename or '',
      name = f.name or f.fullname or ('font' .. fid),
      size = bp(f.size or 655360),
      encb = f.encodingbytes or 0,
      fmt = f.format or '',
    }
  end
end

local function hex2(v)
  return string.format('%02x', math.max(0, math.min(255, math.floor(v + 0.5))))
end

local function parse_color(data)
  if not data then return nil end
  -- recognize the common color ops emitted by the LaTeX color stack
  local r, g, b = data:match('^([%d.]+)%s+([%d.]+)%s+([%d.]+)%s+rg')
  if r then return '#' .. hex2(r * 255) .. hex2(g * 255) .. hex2(b * 255) end
  local gr = data:match('^([%d.]+)%s+g')
  if gr then local v = hex2(gr * 255) return '#' .. v .. v .. v end
  local c, m, y, k = data:match('^([%d.]+)%s+([%d.]+)%s+([%d.]+)%s+([%d.]+)%s+k')
  if c then
    return '#' .. hex2(255 * (1 - math.min(1, c + k))) ..
      hex2(255 * (1 - math.min(1, m + k))) ..
      hex2(255 * (1 - math.min(1, y + k)))
  end
  return nil
end

-- Walker state: color stack shared across the whole galley walk.
local colstack = {}
local function curcolor()
  return colstack[#colstack] or '#000000'
end

-- Emit into `out` flat runs: {f=,s=,dy=,x=,c=,g='utf8 string', gx={per-glyph x}}
-- and rules {rule=true,x=,dy=,w=,h=}. dy is relative to the line baseline
-- (negative = raised). Runs are split at every kern/glue so the browser does
-- no shaping of its own: positions are TeX's.

local walk_h, walk_v

walk_h = function(head, parent, x0, dy0, out)
  local x = x0
  local run = nil
  local function flush()
    if run and #run.g > 0 then out[#out + 1] = run end
    run = nil
  end
  local n = head
  while n do
    local id = n.id
    if id == GLYPH then
      note_font(n.font)
      local fi = seen_fonts[n.font]
      local gy = dy0 - bp(n.yoffset or 0)
      local gx = x + bp(n.xoffset or 0)
      if not run or run.f ~= n.font or run.dy ~= gy or run.c ~= curcolor() then
        flush()
        run = { f = n.font, s = fi and fi.size or 10, dy = gy, x = gx, c = curcolor(), g = {}, gh = 0, gd = 0 }
      end
      -- slots below 32 (legacy greek etc.) travel as PUA so JSON stays clean
      local c = n.char or 63
      -- big cmex variants (large radicals, delimiters, operators) have no
      -- browser-drawable unicode twin of the right size: route the block
      -- through the exact-render tier (glyphs remain as instant preview)
      if fi and fi.name and fi.name:find('^cmex') then
        if (c >= 0x10 and c <= 0x4f) or (c >= 0x58 and c <= 0x77) then
          blk_gfx = true
        end
      end
      if c < 32 then c = 0xE000 + c end
      run.g[#run.g + 1] = { c, gx }
      -- actual glyph extents from TeX's font tables (needed for the OMX
      -- vertical correction when substituting unicode twins client-side)
      local fdata = font.getfont(n.font)
      local cinfo = fdata and fdata.characters and fdata.characters[n.char]
      if cinfo then
        if bp(cinfo.height or 0) > run.gh then run.gh = bp(cinfo.height or 0) end
        if bp(cinfo.depth or 0) > run.gd then run.gd = bp(cinfo.depth or 0) end
      end
      x = x + bp(n.width or 0)
    elseif id == KERN then
      flush()
      x = x + bp(n.kern or 0)
    elseif id == GLUE then
      flush()
      x = x + bp(node.effective_glue(n, parent) or 0)
    elseif id == HLIST then
      flush()
      walk_h(n.list, n, x, dy0 + bp(n.shift or 0), out)
      x = x + bp(n.width or 0)
    elseif id == VLIST then
      flush()
      walk_v(n, x, dy0 + bp(n.shift or 0), out)
      x = x + bp(n.width or 0)
    elseif id == RULE then
      flush()
      local w = n.width
      local h = n.height
      local d = n.depth
      if w and w < -1073741823 then w = parent and parent.width or 0 end
      if h and h < -1073741823 then h = parent and parent.height or 0 end
      if d and d < -1073741823 then d = parent and parent.depth or 0 end
      out[#out + 1] = { rule = true, x = x, dy = dy0 - bp(h), w = bp(w), h = bp(h) + bp(d), c = curcolor() }
      x = x + bp(w or 0)
    elseif id == DISC then
      -- post-linebreak: the replace text is what shows mid-line
      flush()
      if n.replace then
        local fake = node.hpack(node.copy_list(n.replace))
        walk_h(fake.list, fake, x, dy0, out)
        x = x + bp(fake.width or 0)
        node.free(fake)
      end
    elseif id == WHATSIT then
      if COL_SUB and n.subtype == COL_SUB then
        flush()
        local cmd = n.command or n.cmd
        local col = n.data and parse_color(n.data)
        if cmd == 1 then
          colstack[#colstack + 1] = col or curcolor()
        elseif cmd == 2 then
          colstack[#colstack] = nil
        elseif col then
          colstack[#colstack] = col
        end
      elseif LIT_SUB and n.subtype == LIT_SUB then
        blk_gfx = true
      end
    end
    n = n.next
  end
  flush()
end

walk_v = function(box, x0, baseline_dy, out)
  -- box is a vlist whose baseline sits at baseline_dy; contents start at its top
  local y = baseline_dy - bp(box.height or 0)
  local n = box.list
  while n do
    local id = n.id
    if id == HLIST then
      local base = y + bp(n.height or 0)
      walk_h(n.list, n, x0 + bp(n.shift or 0), base, out)
      y = y + bp(n.height or 0) + bp(n.depth or 0)
    elseif id == VLIST then
      walk_v(n, x0 + bp(n.shift or 0), y + bp(n.height or 0), out)
      y = y + bp(n.height or 0) + bp(n.depth or 0)
    elseif id == RULE then
      local h = n.height
      local d = n.depth
      local w = n.width
      if h and h < -1073741823 then h = 26214 end
      if d and d < -1073741823 then d = 0 end
      if w and w < -1073741823 then w = box.width end
      out[#out + 1] = { rule = true, x = x0, dy = y, w = bp(w), h = bp(h) + bp(d), c = curcolor() }
      y = y + bp(h) + bp(d)
    elseif id == GLUE then
      y = y + bp(node.effective_glue(n, box) or 0)
    elseif id == KERN then
      y = y + bp(n.kern or 0)
    elseif id == WHATSIT then
      if LIT_SUB and n.subtype == LIT_SUB then blk_gfx = true end
    end
    n = n.next
  end
end

TDOM_BOXNUM = 254 -- overwritten by the driver right after \newbox\TDOMgalley

-- Top level: the galley vbox -> vertical items with per-line runs.
local function extract_galley()
  local box = tex.box[TDOM_BOXNUM]
  local items = {}
  if not box then return items, 0, 0, 0 end
  colstack = {}
  local n = box.list
  while n do
    local id = n.id
    if id == HLIST or id == VLIST or id == RULE then
      local h = n.height or 0
      local d = n.depth or 0
      local w = n.width or 0
      if id == RULE then
        if w < -1073741823 then w = box.width or 0 end
        if h < -1073741823 then h = 26214 end
        if d < -1073741823 then d = 0 end
      end
      local runs = {}
      if id == HLIST then
        walk_h(n.list, n, 0, 0, runs)
      elseif id == VLIST then
        walk_v(n, 0, bp(h), runs)
      else
        runs[1] = { rule = true, x = 0, dy = -bp(h), w = bp(w), h = bp(h) + bp(d), c = '#000000' }
      end
      items[#items + 1] = { k = 'box', h = bp(h), d = bp(d), w = bp(w), runs = runs }
    elseif id == GLUE then
      items[#items + 1] = { k = 'glue', a = bp(node.effective_glue(n, box) or n.width) }
    elseif id == KERN then
      items[#items + 1] = { k = 'kern', a = bp(n.kern or 0) }
    elseif id == PENALTY then
      items[#items + 1] = { k = 'pen', v = n.penalty or 0 }
    end
    n = n.next
  end
  return items, bp(box.width or 0), bp(box.height or 0), bp(box.depth or 0)
end

-- ---------------------------------------------------------- reporting

local function encode_runs(items)
  -- Runs are split at every kern/glue during the walk, so within a run the
  -- browser reproduces TeX's positions from pure font advances; only the
  -- run-start x needs to travel.
  for _, it in ipairs(items) do
    if it.runs then
      for _, r in ipairs(it.runs) do
        if r.g then
          local chars = {}
          for i, pair in ipairs(r.g) do
            chars[i] = unicode.utf8.char(pair[1] > 0 and pair[1] or 63)
          end
          r.t = table.concat(chars)
          r.g = nil
        end
      end
    end
  end
end

function tdom_report()
  local items, w, h, d = extract_galley()
  encode_runs(items)
  local fonts = {}
  for fid, f in pairs(seen_fonts) do
    if not f.sent then
      fonts[tostring(fid)] = { file = f.file, name = f.name, size = f.size, fmt = f.fmt }
      f.sent = true
    end
  end
  local payload = jenc({
    block = JOB.id,
    gfx = blk_gfx,
    w = w,
    h = h,
    d = d,
    items = items,
    fonts = fonts,
    labels = blk_labels,
    refs = blk_refs,
    state = blk_counters,
  })
  conn:send('GALLEY ' .. JOB.id .. ' ' .. #payload .. '\n')
  conn:send(payload)
  -- this child now becomes the next checkpoint in the chain
  CKPT = JOB.ckpt
  conn:send('CKPT ' .. CKPT .. ' ' .. fk.getpid() .. '\n')
  JOB = nil
end

-- ------------------------------------------------------------ shipping

function tdom_ship()
  local box = tex.box[TDOM_BOXNUM]
  if not box then return end
  local b = node.copy_list(box)
  local w = math.max(b.width or 0, 65536)
  local total = math.max((b.height or 0) + (b.depth or 0), 65536)
  tex.box[255] = b
  tex.pagewidth = w
  tex.pageheight = total
end

-- --------------------------------------------------------- the loop

function tdom_wait()
  while true do
    local line, err = conn:receive('*l')
    if not line then
      fk._exit(0) -- orchestrator went away
    end
    local cmd, a, b, c = line:match('^(%S+)%s*(%S*)%s*(%S*)%s*(%S*)')
    if cmd == 'DIE' then
      fk._exit(0)
    elseif cmd == 'PING' then
      conn:send('PONG ' .. CKPT .. '\n')
    elseif cmd == 'JOB' then
      -- JOB <blockId> <newCkptIdx> <noindentFlag>:<bodyLen>
      local id = a
      local newckpt = tonumber(b) or (CKPT + 1)
      local noind, len = c:match('^(%d):(%d+)$')
      len = tonumber(len) or 0
      local body = len > 0 and conn:receive(len) or ''
      local pid = fk.fork()
      if pid == 0 then
        JOB = { id = id, ckpt = newckpt, body = body, noindent = noind == '1' }
        blk_labels = {}
        blk_refs = {}
        blk_counters = {}
        blk_gfx = false
        reconnect('job', newckpt)
        inject_job(body, false)
        return -- resume TeX: typeset, report, then \TDOMloop brings us back
      else
        conn:send('FORKED ' .. id .. ' ' .. pid .. '\n')
      end
    elseif cmd == 'RENDER' then
      local id = a
      local jobdir = b
      local len = tonumber(c) or 0
      local body = len > 0 and conn:receive(len) or ''
      local pid = fk.fork()
      if pid == 0 then
        JOB = { id = id, ckpt = -1, body = body }
        reconnect('render', 0)
        lfs.chdir(jobdir)
        -- under LaTeX, raw callback.register is owned by luatexbase
        local notify = function()
          pcall(function()
            conn:send('DONE ' .. id .. '\n')
          end)
        end
        if luatexbase and luatexbase.add_to_callback then
          pcall(luatexbase.add_to_callback, 'finish_pdffile', notify, 'tdom')
        else
          pcall(callback.register, 'finish_pdffile', notify)
        end
        inject_job(body, true)
        return
      else
        conn:send('FORKED ' .. id .. ' ' .. pid .. '\n')
      end
    end
  end
end

function inject_job(body, ship)
  local lines = {}
  lines[#lines + 1] = '\\global\\setbox\\TDOMgalley=\\vbox{\\hsize=\\textwidth'
  if JOB and JOB.noindent then lines[#lines + 1] = '\\noindent' end
  for l in (body .. '\n'):gmatch('(.-)\n') do
    lines[#lines + 1] = l
  end
  lines[#lines + 1] = '\\par}'
  if ship then
    lines[#lines + 1] = '\\directlua{tdom_ship()}'
    lines[#lines + 1] = '\\shipout\\box255'
    lines[#lines + 1] = '\\csname @@end\\endcsname'
  else
    for _, name in ipairs(COUNTERS) do
      lines[#lines + 1] = '\\ifcsname c@' .. name .. '\\endcsname\\directlua{tdom_counter(\'' ..
        name .. '\',\\number\\value{' .. name .. '})}\\fi'
    end
    lines[#lines + 1] = '\\directlua{tdom_report()}'
  end
  tex.print(lines)
end
