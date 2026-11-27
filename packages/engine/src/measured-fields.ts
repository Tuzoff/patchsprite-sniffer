// The measured fields of a device map, with no imports: each field's unit, its largest value, and whether 0 is refused
// (`positive`). Every one takes the shared measured shape (MeasuredValueSchema in protocol-schema.ts).

export const MEASURED_FIELDS = {
  "audio.reamp.overhead": { unit: "s", max: 60 },
  "transport.timing.compareToggle": { unit: "ms", max: 600_000 },
  "host.editor.attachDelay": { unit: "s", max: 60 },
  // one request's round trip, median and p95
  "transport.timing.measured.roundTripMedianMs": { unit: "ms", max: 60_000, positive: true },
  "transport.timing.measured.roundTripP95Ms": { unit: "ms", max: 60_000, positive: true },
} as const;
