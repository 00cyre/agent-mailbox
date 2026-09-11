-- Last-resort paste into the official Grok Bot Mac app (x.ai/bot).
-- Grok Bot has no public HTTP API or documented URL scheme for a specific
-- teammate thread. This activates the app and pastes the prompt via System
-- Events. Accessibility permission for osascript / Terminal / node is required.
-- argv: path-to-utf8-prompt-file

on run argv
	if (count of argv) < 1 then error "grokbot-paste: missing prompt file"
	set promptPath to item 1 of argv
	set promptText to do shell script "python3 -c 'import sys; print(open(sys.argv[1], encoding=\"utf-8\").read())' " & quoted form of promptPath
	set the clipboard to promptText
	tell application "Grok Bot" to activate
	delay 1
	tell application "System Events"
		tell process "Grok Bot"
			set frontmost to true
			delay 0.3
			keystroke "v" using command down
			delay 0.3
			key code 36
		end tell
	end tell
	return "ok"
end run
