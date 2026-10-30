#!/bin/sh
# Test transport for password mode. Verifies that ssh was launched with the
# askpass environment instead of BatchMode, then executes the final argv as a
# local POSIX shell command. A control operation ends in the host name only.
for opencc_arg do
  opencc_last=$opencc_arg
done

case " $* " in
  *" BatchMode=yes "*)
    echo "BatchMode=yes must not be used in password mode" >&2
    exit 90
    ;;
esac
case " $* " in
  *" PreferredAuthentications=password,keyboard-interactive "*)
    ;;
  *)
    echo "password authentication options are missing" >&2
    exit 91
    ;;
esac
[ -n "$SSH_ASKPASS" ] || {
  echo "SSH_ASKPASS is missing" >&2
  exit 92
}
[ "$SSH_ASKPASS_REQUIRE" = "force" ] || {
  echo "SSH_ASKPASS_REQUIRE=force is missing" >&2
  exit 93
}
opencc_got=$("$SSH_ASKPASS") || {
  echo "askpass helper failed" >&2
  exit 94
}
[ "$opencc_got" = "$OPENCC_TEST_PASSWORD" ] || {
  echo "askpass returned the wrong password" >&2
  exit 95
}

if [ "$opencc_last" = "fake-host" ]; then
  exit 0
fi

exec /bin/sh -c "$opencc_last"
