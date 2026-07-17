#!/bin/sh

if type update-alternatives >/dev/null 2>&1; then
    # Remove a legacy direct link before registering the managed alternative.
    if [ -L '/usr/bin/platform-desktop' ] &&
       [ -e '/usr/bin/platform-desktop' ] &&
       [ "$(readlink '/usr/bin/platform-desktop')" != '/etc/alternatives/platform-desktop' ]; then
        rm -f '/usr/bin/platform-desktop'
    fi
    update-alternatives --install '/usr/bin/platform-desktop' 'platform-desktop' '/opt/Meeting Intelligence/platform-desktop' 100 ||
        ln -sf '/opt/Meeting Intelligence/platform-desktop' '/usr/bin/platform-desktop'
else
    ln -sf '/opt/Meeting Intelligence/platform-desktop' '/usr/bin/platform-desktop'
fi

# RPM invokes scriptlets with /bin/sh. Keep the probe POSIX-compatible so a
# missing Bash extension cannot roll back install or post-transaction repair.
if ! { [ -L /proc/self/ns/user ] && unshare --user true; }; then
    chmod 4755 '/opt/Meeting Intelligence/chrome-sandbox' || true
else
    chmod 0755 '/opt/Meeting Intelligence/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install the generated AppArmor profile only when the host supports its ABI.
if apparmor_status --enabled >/dev/null 2>&1; then
    APPARMOR_PROFILE_SOURCE='/opt/Meeting Intelligence/resources/apparmor-profile'
    APPARMOR_PROFILE_TARGET='/etc/apparmor.d/platform-desktop'
    if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" >/dev/null 2>&1; then
        cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

        if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } &&
           hash apparmor_parser 2>/dev/null; then
            apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
        fi
    else
        echo "Skipping the AppArmor profile because this host does not support the bundled profile"
    fi
fi
