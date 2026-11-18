# Hook client for the resident hook daemon (scripts/hookd.mjs). Sourced by the hook command, not executed:
#
#   . "${CLAUDE_PLUGIN_ROOT}/scripts/hook-client.sh" <pluginId> "${CLAUDE_PLUGIN_ROOT}"
#
# Sourcing avoids a second bash start. Everything on the fast path is a bash builtin: no node, no cat, no curl, no
# fork except the one `cat` that drains a payload larger than the builtin read window.
#
# Fail open: every failure ends in `node hook.mjs`, which prints nothing and exits 0 on anything it cannot handle.
# Set CLAUDE_HOOKD_DISABLE=1 to force the plain node path.

_hk_id=${1:-}
_hk_root=${2:-${CLAUDE_PLUGIN_ROOT:-}}
_hk_had_lc=${LC_ALL+set}
_hk_old_lc=${LC_ALL-}
_hk_have_payload=
_hk_payload=

# Runs the original hook script. If stdin was already consumed it is replayed from memory; otherwise node inherits it.
_hk_node() {
  trap - PIPE
  exec 3>&-
  if [[ -n $_hk_had_lc ]]; then LC_ALL=$_hk_old_lc; else unset LC_ALL; fi
  if [[ -n $_hk_have_payload ]]; then
    printf '%s' "$_hk_payload" | node "$_hk_root/scripts/hook.mjs"
    exit $?
  fi
  exec node "$_hk_root/scripts/hook.mjs"
}

if [[ -n ${CLAUDE_HOOKD_DISABLE-} && ${CLAUDE_HOOKD_DISABLE} != 0 ]]; then _hk_node; fi
[[ -n $_hk_id && -n $_hk_root ]] || _hk_node

# Locate the state file the daemon writes. No state file means no daemon: do not attempt a connection, because a
# refused loopback connect costs about 2 s on Windows.
_hk_dir=
if [[ -n ${CLAUDE_HOOKD_STATE_DIR-} ]]; then
  [[ -r $CLAUDE_HOOKD_STATE_DIR/state ]] && _hk_dir=$CLAUDE_HOOKD_STATE_DIR
else
  for _hk_tmp in "${TMPDIR-}" "${TEMP-}" "${TMP-}" /tmp; do
    if [[ -n $_hk_tmp && -r $_hk_tmp/claude-code-hookd/$_hk_id/state ]]; then
      _hk_dir=$_hk_tmp/claude-code-hookd/$_hk_id
      break
    fi
  done
fi
[[ -n $_hk_dir ]] || _hk_node

_hk_port=
_hk_alive=
while IFS='=' read -r _hk_key _hk_val; do
  case $_hk_key in
    port) _hk_port=$_hk_val ;;
    aliveAt) _hk_alive=$_hk_val ;;
  esac
done < "$_hk_dir/state"
[[ $_hk_port =~ ^[0-9]+$ && $_hk_alive =~ ^[0-9]+$ ]] || _hk_node

# The daemon refreshes aliveAt every 10 s; a heartbeat older than 40 s means it died without cleaning up.
printf -v _hk_now '%(%s)T' -1
(( _hk_now - _hk_alive < 40 )) || _hk_node

_hk_token=
IFS= read -r _hk_token < "$_hk_dir/token" 2>/dev/null
[[ -n $_hk_token ]] || _hk_node

# Connect before touching stdin, so a failed connect leaves stdin intact for node. A refused connection means the
# state file lies: blank it so the 2 s penalty is paid once, not once per event.
trap '' PIPE
{ exec 3<>"/dev/tcp/127.0.0.1/$_hk_port"; } 2>/dev/null || { : > "$_hk_dir/state"; _hk_node; }

# Read stdin: a 4 KB builtin read (byte-at-a-time on a pipe, so kept small), then one `cat` only for the remainder.
LC_ALL=C
if IFS= read -r -N 4096 _hk_payload; then
  _hk_rest=$(cat)
  _hk_payload+=$_hk_rest
fi
_hk_have_payload=1
(( ${#_hk_payload} <= 1048576 )) || _hk_node

# Forward the plugin's own configuration. A value containing a newline cannot be framed, so use node instead.
_hk_n=1
_hk_envlines="CLAUDE_PLUGIN_ROOT=$_hk_root"$'\n'
for _hk_name in "${!CLAUDE_PLUGIN_@}"; do
  case $_hk_name in
    CLAUDE_PLUGIN_DATA | CLAUDE_PLUGIN_OPTION_*)
      _hk_val=${!_hk_name}
      [[ $_hk_val != *$'\n'* ]] || _hk_node
      _hk_envlines+="$_hk_name=$_hk_val"$'\n'
      _hk_n=$((_hk_n + 1))
      ;;
  esac
done

_hk_event=Event
if [[ ${_hk_payload:0:4096} =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"([A-Za-z]{1,40})\" ]]; then
  _hk_event=${BASH_REMATCH[1]}
fi

{ printf '%s\n%s %s %s\n%s\n%s%s' "$_hk_token" "$_hk_id" "$_hk_event" "${#_hk_payload}" "$_hk_n" "$_hk_envlines" "$_hk_payload" >&3; } 2>/dev/null || _hk_node

# The daemon replies with the handler's stdout, a newline, then the exit code (or FALLBACK) and a newline, then closes.
_hk_reply=
IFS= read -r -d '' -t "${CLAUDE_HOOKD_CLIENT_TIMEOUT:-3}" -u 3 _hk_reply
_hk_rc=$?
exec 3>&-
trap - PIPE

# A late, dropped or garbled reply means the daemon is hung or unhealthy: blank the state file so the next events go
# straight to node instead of each waiting out the timeout. A live daemon rewrites it at its next heartbeat.
_hk_sick() {
  : > "$_hk_dir/state"
  _hk_node
}
(( _hk_rc <= 1 )) || _hk_sick

_hk_reply=${_hk_reply%$'\n'}
[[ $_hk_reply == *$'\n'* ]] || _hk_sick
_hk_code=${_hk_reply##*$'\n'}
if [[ $_hk_code == FALLBACK ]]; then _hk_node; fi
[[ $_hk_code =~ ^[0-9]{1,3}$ ]] || _hk_sick
_hk_reply=${_hk_reply%$'\n'*}

if [[ -n $_hk_had_lc ]]; then LC_ALL=$_hk_old_lc; else unset LC_ALL; fi
printf '%s' "$_hk_reply"
exit "$_hk_code"
