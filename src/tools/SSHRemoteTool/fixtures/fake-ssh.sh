#!/bin/sh
# Test transport: ignore ssh options/destination and execute the final argv as
# a local POSIX shell command. A control operation ends in the host name only.
for opencc_arg do
  opencc_last=$opencc_arg
done

if [ "$opencc_last" = "fake-host" ]; then
  exit 0
fi

exec /bin/sh -c "$opencc_last"
