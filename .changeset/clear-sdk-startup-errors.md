---
"@inv1x/pi-subagents": patch
---

Preserve SDK child startup failures instead of masking them with IPC `write EPIPE` errors. Report the Node.js executable and suggest restarting Pi when a missing executable may be caused by a Node upgrade. Only send the invocation after the child spawns successfully.
