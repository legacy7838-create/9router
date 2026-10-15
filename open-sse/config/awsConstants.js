// === AWS EventStream framing ===
// Protocol-level bounds for every AWS EventStream consumer (Kiro's CodeWhisperer stream),
// so they cannot drift apart.
export const AWS_EVENTSTREAM = {
  maxMessageBytes: 24 * 1024 * 1024,
  maxHeadersBytes: 128 * 1024,
};
