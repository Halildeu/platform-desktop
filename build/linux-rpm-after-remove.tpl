#!/bin/sh

# RPM passes the number of remaining package versions as $1. During an
# upgrade, the old package's postun runs after the new package's postinstall;
# removing shared registrations there would break the newly installed version.
if [ "${1:-0}" -gt 0 ]; then
    exit 0
fi

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
fi

# update-alternatives can exist while its install operation fails. In that
# case afterInstall creates this exact direct-link fallback; remove only that
# package-owned link and leave any alternative selected for another provider.
if [ -L '/usr/bin/${executable}' ] &&
   [ "$(readlink '/usr/bin/${executable}')" = '/opt/${sanitizedProductName}/${executable}' ]; then
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

if [ -f "$APPARMOR_PROFILE_DEST" ]; then
    if apparmor_status --enabled >/dev/null 2>&1; then
        if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } &&
           hash apparmor_parser 2>/dev/null; then
            apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
        fi
    fi
    rm -f "$APPARMOR_PROFILE_DEST"
fi
