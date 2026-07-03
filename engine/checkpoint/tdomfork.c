/* tdomfork.c — process-control bridge for stock LuaTeX (Lua 5.3 ABI).
 *
 * The checkpoint engine freezes TeX states by fork(): the parent process IS
 * the snapshot, children are alternative continuations. This shim exposes
 * exactly the four primitives that mechanism needs.
 *
 * Lua API symbols are resolved against the host luatex process at load time,
 * so no Lua headers or libraries are needed to build:
 *   macOS: cc -O2 -shared -undefined dynamic_lookup -o tdomfork.so tdomfork.c
 *   Linux: cc -O2 -shared -fPIC -o tdomfork.so tdomfork.c
 */

#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>

typedef struct lua_State lua_State;
typedef long long lua_Integer;
typedef int (*lua_CFunction)(lua_State *);

extern void lua_pushinteger(lua_State *L, lua_Integer n);
extern lua_Integer lua_tointegerx(lua_State *L, int idx, int *isnum);
extern void lua_createtable(lua_State *L, int narr, int nrec);
extern void lua_pushcclosure(lua_State *L, lua_CFunction fn, int n);
extern void lua_setfield(lua_State *L, int idx, const char *k);

static int l_fork(lua_State *L) {
  lua_pushinteger(L, (lua_Integer)fork());
  return 1;
}

static int l_getpid(lua_State *L) {
  lua_pushinteger(L, (lua_Integer)getpid());
  return 1;
}

static int l_waitpid(lua_State *L) {
  int status = 0;
  pid_t pid = waitpid((pid_t)lua_tointegerx(L, 1, 0), &status, 0);
  lua_pushinteger(L, (lua_Integer)pid);
  lua_pushinteger(L, (lua_Integer)status);
  return 2;
}

static int l_exit(lua_State *L) {
  _exit((int)lua_tointegerx(L, 1, 0));
  return 0;
}

/* Checkpoint parents never wait for their (long-lived) children; ignore
 * SIGCHLD so exited render children do not accumulate as zombies. */
static int l_ignore_sigchld(lua_State *L) {
  (void)L;
  signal(SIGCHLD, SIG_IGN);
  return 0;
}

int luaopen_tdomfork(lua_State *L) {
  lua_createtable(L, 0, 5);
  lua_pushcclosure(L, l_fork, 0);
  lua_setfield(L, -2, "fork");
  lua_pushcclosure(L, l_getpid, 0);
  lua_setfield(L, -2, "getpid");
  lua_pushcclosure(L, l_waitpid, 0);
  lua_setfield(L, -2, "waitpid");
  lua_pushcclosure(L, l_exit, 0);
  lua_setfield(L, -2, "_exit");
  lua_pushcclosure(L, l_ignore_sigchld, 0);
  lua_setfield(L, -2, "ignore_sigchld");
  return 1;
}
