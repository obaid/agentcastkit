#!/bin/zsh
set -euo pipefail

clear
print "AgentCastKit — Apple notarization setup"
print ""
print "This uses Apple's notarytool and stores the credential in your login Keychain."
print "Use an app-specific password, not your normal Apple ID password."
print ""

xcrun notarytool store-credentials AgentCastKit --team-id U25ZJ9KG26

print ""
print "AgentCastKit notarization credentials are ready."
print "You can close this Terminal window and return to Codex."
read "?Press Return to close."
