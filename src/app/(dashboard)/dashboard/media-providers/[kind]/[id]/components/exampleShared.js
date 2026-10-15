"use client";

export function Row({ label, children }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-full text-xs font-medium text-text-muted sm:w-20 sm:shrink-0">{label}</span>
      <div className="w-full min-w-0 flex-1">{children}</div>
    </div>
  );
}

export const KIND_EXAMPLE_CONFIG = {
  systemone: {
    inputLabel: "State",
    inputPlaceholder: "Situation, support ticket, or text to evaluate",
    defaultInput: "My payments have failed for three days and I am losing sales. Please help now.",
    bodyKey: "state",
    extraBody: {
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "Does this request require urgent attention?",
        },
      },
    },
    defaultResponse: `{\n  "model": "jev-1.13",\n  "answers": {\n    "is_urgent": { "type": "noul", "noul": 0.99 }\n  },\n  "usage": { "input_tokens": 312, "output_tokens": 48 }\n}`,
  },
};
