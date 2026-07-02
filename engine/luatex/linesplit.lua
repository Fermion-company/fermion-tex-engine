-- linesplit.lua — TDOM LuaTeX driver support.
--
-- For each dirty block the driver typesets the block into a \vbox, then:
--   1. tdom_split walks the vbox's vertical list recording every line box
--      (height/depth/width/y-offset), glue, kern and penalty — the real
--      galley stream TeX produced, in big points.
--   2. tdom_load_whole ships the whole block as one tight PDF page (the
--      chunk image); the engine's own paginator later slices it by lines.
--   3. Counter exit-states are recorded after each block so the engine can
--      chain block compilations exactly like TeX's own galley would.
--
-- Output: one PDF page per block + meta JSON with per-block galley items.

local blocks = {}
local current = nil
local shipped = 0

local SP_PER_BP = 65781.76

local function bp(sp)
  return math.floor((sp / SP_PER_BP) * 1000 + 0.5) / 1000
end

local function json_str(s)
  s = tostring(s)
  s = s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', ''):gsub('\t', '\\t')
  return '"' .. s .. '"'
end

function tdom_begin_block(id)
  current = { id = id, items = {}, entry = {}, exit = {}, page = nil, w = 0, h = 0, d = 0 }
  blocks[#blocks + 1] = current
end

function tdom_entry_state(name, value)
  if current then current.entry[name] = tonumber(value) or 0 end
end

function tdom_split(boxnum)
  local outer = tex.box[boxnum]
  if not outer or not current then return end
  local items = current.items
  local n = outer.list
  local y = 0
  while n do
    local t = node.type(n.id)
    if t == "hlist" or t == "vlist" or t == "rule" then
      local w = n.width or 0
      local h = n.height or 0
      local d = n.depth or 0
      if t == "rule" then
        if w < -1073741823 then w = outer.width or 0 end
        if h < -1073741823 then h = 26214 end
        if d < -1073741823 then d = 0 end
      end
      items[#items + 1] = {
        kind = "box",
        y = bp(y),
        w = bp(w),
        h = bp(h),
        d = bp(d),
      }
      y = y + h + d
    elseif t == "glue" then
      items[#items + 1] = { kind = "glue", amount = bp(n.width or 0), subtype = n.subtype or 0 }
      y = y + (n.width or 0)
    elseif t == "kern" then
      items[#items + 1] = { kind = "kern", amount = bp(n.kern or 0) }
      y = y + (n.kern or 0)
    elseif t == "penalty" then
      items[#items + 1] = { kind = "penalty", value = n.penalty or 0 }
    end
    n = n.next
  end
end

-- Ship the whole block box as one tight page.
function tdom_load_whole(boxnum)
  local orig = tex.box[boxnum]
  if not orig or not current then
    tex.box[255] = node.new("vlist")
    tex.pagewidth = 65536
    tex.pageheight = 65536
    return
  end
  local b = node.copy_list(orig)
  local w = math.max(b.width or 0, 65536)
  local total = math.max((b.height or 0) + (b.depth or 0), 65536)
  tex.box[255] = b
  tex.pagewidth = w
  tex.pageheight = total
  shipped = shipped + 1
  current.page = shipped
  current.w = bp(w)
  current.h = bp(b.height or 0)
  current.d = bp(b.depth or 0)
end

function tdom_state(name, value)
  if current then current.exit[name] = tonumber(value) or 0 end
end

function tdom_finish(path)
  local f = io.open(path, "w")
  f:write('{"blocks":[\n')
  for bi, blk in ipairs(blocks) do
    f:write('{"id":' .. json_str(blk.id) .. ',"page":' .. tostring(blk.page or 0))
    f:write(',"w":' .. tostring(blk.w) .. ',"h":' .. tostring(blk.h) .. ',"d":' .. tostring(blk.d))
    for _, field in ipairs({ "entry", "exit" }) do
      f:write(',"' .. field .. '":{')
      local first = true
      for k, v in pairs(blk[field]) do
        if not first then f:write(',') end
        f:write(json_str(k) .. ':' .. tostring(v))
        first = false
      end
      f:write('}')
    end
    f:write(',"items":[')
    for ii, it in ipairs(blk.items) do
      if ii > 1 then f:write(',') end
      if it.kind == "box" then
        f:write(string.format('{"kind":"box","y":%s,"w":%s,"h":%s,"d":%s}', it.y, it.w, it.h, it.d))
      elseif it.kind == "glue" then
        f:write(string.format('{"kind":"glue","amount":%s,"subtype":%s}', it.amount, it.subtype))
      elseif it.kind == "kern" then
        f:write(string.format('{"kind":"kern","amount":%s}', it.amount))
      else
        f:write(string.format('{"kind":"penalty","value":%s}', it.value))
      end
    end
    f:write(']}')
    if bi < #blocks then f:write(',') end
    f:write('\n')
  end
  f:write(']}\n')
  f:close()
end

-- Geometry probe: dump layout dimensions as JSON (all in bp).
function tdom_probe(path)
  local function dim(name)
    local ok, v = pcall(function() return tex.dimen[name] end)
    if ok and v then return bp(v) end
    return 0
  end
  local f = io.open(path, "w")
  f:write(string.format(
    '{"paperwidth":%s,"paperheight":%s,"textwidth":%s,"textheight":%s,' ..
    '"oddsidemargin":%s,"topmargin":%s,"headheight":%s,"headsep":%s,' ..
    '"baselineskip":%s,"lineskip":%s,"lineskiplimit":%s,"parskip":%s,' ..
    '"topskip":%s,"maxdepth":%s,"parindent":%s}\n',
    dim("paperwidth"), dim("paperheight"), dim("textwidth"), dim("textheight"),
    dim("oddsidemargin"), dim("topmargin"), dim("headheight"), dim("headsep"),
    bp(tex.baselineskip.width or 0), bp(tex.lineskip.width or 0),
    bp(tex.lineskiplimit or 0), bp(tex.parskip.width or 0),
    bp(tex.topskip.width or 0), bp(tex.maxdepth or 0), bp(tex.parindent or 0)
  ))
  f:close()
end
