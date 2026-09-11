-- Inject a prompt into a grok.com conversation and wait for the next reply.
-- argv: threadId, path-to-utf8-prompt-file, path-to-inject.js
--
-- grok.com has no public API that continues a web chat by id.
-- URLs: https://grok.com/c/{uuid}
-- Safari: Develop → Allow JavaScript from Apple Events.

on run argv
	if (count of argv) < 3 then error "grok-safari-send: need thread id, prompt file, inject.js"
	set threadId to item 1 of argv
	set promptPath to item 2 of argv
	set injectPath to item 3 of argv
	set payload to do shell script "python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1], encoding=\"utf-8\").read()))' " & quoted form of promptPath
	set injectJS to do shell script "python3 -c 'import sys; print(open(sys.argv[1], encoding=\"utf-8\").read())' " & quoted form of injectPath

	set targetURL to "https://grok.com/c/" & threadId
	tell application "Safari"
		activate
		set foundTab to false
		repeat with w in windows
			repeat with t in tabs of w
				if (URL of t as string) contains threadId then
					set current tab of w to t
					set index of w to 1
					set foundTab to true
					exit repeat
				end if
			end repeat
			if foundTab then exit repeat
		end repeat
		if not foundTab then
			if (count of windows) is 0 then make new document
			tell window 1
				set URL of current tab to targetURL
			end tell
			delay 3
		end if
		delay 1
		do JavaScript "window.__mailboxPrompt = " & payload & ";" in current tab of window 1
		set outcome to do JavaScript injectJS in current tab of window 1
		return outcome
	end tell
end run
