# Security policy

simple-remote-pair injects mouse and keyboard input into the host machine, so security reports are taken seriously.

## Scope and threat model

The tool is designed for **trusted networks** (LAN or VPN). The session code is the authentication boundary: anyone who can reach the server *and* present a valid code can watch the stream and — unless restricted — control the host. It is not designed to be exposed to the public internet, and reports assuming an internet-facing deployment will be treated as documentation issues rather than vulnerabilities.

In scope, for example:

- Controlling a host or receiving the stream **without** a valid session code
- Escalating from view-only to control without the host granting it
- Input injection that survives kick/revoke/pause, or crashes the server with crafted messages

## Reporting

Please **do not open a public issue** for vulnerabilities. Use GitHub's private vulnerability reporting on this repository ("Report a vulnerability" under the Security tab). You can expect an acknowledgement within a week.

## Supported versions

Only the latest release receives security fixes.
