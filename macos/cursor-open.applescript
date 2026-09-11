-- Open a Cursor Cloud Agent by id.
-- Public deeplink: cursor://anysphere.cursor-deeplink/background-agent?bcId=
-- Documented at https://cursor.com/docs/reference/deeplinks and the Cloud Agent
-- "open by id" help thread. This does not inject into an arbitrary local composer
-- chat — Cursor has no public URL scheme for that.

on run argv
	if (count of argv) < 1 then error "cursor-open: missing thread id"
	set threadId to item 1 of argv
	set u to "cursor://anysphere.cursor-deeplink/background-agent?bcId=" & threadId
	tell application "System Events"
		if exists (processes where name is "Cursor") then
			tell application "Cursor" to activate
		end if
	end tell
	do shell script "open " & quoted form of u
	return "ok"
end run
