# 30-Minute Demonstration Script

## 0:00-3:00 | Framing the experiment

Introduce the question: what changes when collaborative updates use one ordered TCP stream versus QUIC streams plus unreliable datagrams? State the control conditions: same browser/hardware, room size, board actions, payload shape, and network impairment. Point out that the dashboard reports observed measurements and that one run does not establish a winner.

## 3:00-7:00 | Start and inspect

Start the backend and Angular client using the WebSocket setup. Open three browser contexts, choose a shared random room ID, give each participant a different name, and join. Show presence, the initial snapshot, the transport status, and the client-measured PING/PONG RTT. Select a color for each user.

## 7:00-12:00 | Scenario A: normal collaboration

Keep WebSocket selected. Have two participants draw different shapes and a stroke simultaneously while the third watches. Add a sticky note, edit its text, move it with Select, and remove a test stroke with Eraser. Compare presence, object count, message rate, and synchronized results.

## 12:00-16:00 | Scenario B: cursor movement

Move each pointer quickly over the canvas. Explain that WebSocket cursor messages share the same reliable ordered TCP connection as commits. Switch all contexts to WebTransport after HTTPS/HTTP/3 setup. Explain that cursor and preview updates use datagrams, where missing a superseded position is acceptable; commits remain reliable.

## 16:00-20:00 | Scenario C: reliable drawing and reload

Draw a complicated shape, wait for the final commit, and reload one client. Confirm that the room snapshot restores it. On WebTransport, explicitly distinguish the lossy preview from the final reliable `DRAW_END` commit.

## 20:00-25:00 | Scenario D: impairment

Open Network simulation. First enable a modest application delay and cursor sampling change, then use a nonzero datagram app-drop percentage in WebTransport mode. Explain that these are application behaviors and are not packet loss. For packet-level tests, use `tc netem` on a controlled Linux interface and apply identical delay/loss to both transport trials. Discuss QUIC’s independent streams and TCP head-of-line blocking carefully: QUIC does not eliminate congestion or reliable retransmission delay.

## 25:00-28:00 | Scenario E: concurrent edits

Have three users draw simultaneously and move different sticky notes. Check presence and snapshots after reload. Repeat comparable actions in each transport; do not compare a single timing sample or different payload/workload sizes.

## 28:00-30:00 | Wrap-up

Summarize what was observed, call out any environment limits (especially browser certificate trust and UDP reachability), and separate measurements from interpretation. The demo has in-memory state and is not production-authenticated; reset it by restarting the server.
