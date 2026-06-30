// Generate a unique identifier for a delta.
export const createDeltaId = () => {

  // Prefer the native UUID generator when available.
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fall back to a timestamp-based identifier.
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
};

// Convert a single Monaco content change into a backend delta.
// Returns null for no-op changes that should not be sent.
export const createDeltaFromChange = (change, { version, userId }) => {

  // Map the Monaco change geometry onto the backend delta fields.
  const position = change.rangeOffset;
  const length = change.rangeLength;
  const text = change.text;

  // Classify the change as insert, delete, or replace.
  let type;
  if (length === 0 && text.length > 0) {
    type = "insert";
  } else if (length > 0 && text.length === 0) {
    type = "delete";
  } else if (length > 0 && text.length > 0) {
    type = "replace";
  } else {
    return null;
  }

  // Build the delta in the backend's expected shape.
  return {
    id: createDeltaId(),
    userId: userId ?? null,
    version,
    timestamp: Date.now(),
    type,
    position,
    length,
    text,
  };
};

// Convert a backend delta into a single Monaco edit operation against a model.
// The range [position, position + length] is replaced by the delta text, which
// uniformly expresses insert (length 0), delete (empty text) and replace.
export const deltaToMonacoOperation = (delta, model) => {

  // Translate the absolute offsets into Monaco positions.
  const start = model.getPositionAt(delta.position);
  const end = model.getPositionAt(delta.position + (delta.length || 0));

  // Describe the edit as a range replacement.
  return {
    range: {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    },
    text: delta.text || "",
    forceMoveMarkers: true,
  };
};

// Deterministic total order over two deltas, used to break insert ties.
// MUST match the server's ConflictResolver.compareSites so both peers agree.
const compareSites = (a, b) => {
  const ua = a.userId ?? "";
  const ub = b.userId ?? "";
  if (ua < ub) return -1;
  if (ua > ub) return 1;

  const ia = a.id ?? "";
  const ib = b.id ?? "";
  if (ia < ib) return -1;
  if (ia > ib) return 1;
  return 0;
};

const shiftPosition = (position, start, removed, inserted, tieAfter) => {
  if (position < start) return position;
  if (position > start) {
    if (position >= start + removed) return position - removed + inserted;
    return start;
  }
  // position === start
  if (removed > 0) return start;
  return tieAfter ? start + inserted : start;
};

// Rebase delta `a` so it applies cleanly on a document that already has `b`
// applied. Mirror of the server's ConflictResolver.transform; used on the
// client to reconcile incoming remote edits against un-acked local edits.
export const transformDelta = (a, b) => {
  const start = b.position;
  const removed = b.length || 0;
  const inserted = b.text ? b.text.length : 0;

  const tieAfter = removed === 0 && compareSites(a, b) > 0;

  const aLength = a.length || 0;
  const position = shiftPosition(a.position, start, removed, inserted, tieAfter);
  const end = shiftPosition(
    a.position + aLength,
    start,
    removed,
    inserted,
    tieAfter
  );

  return {
    ...a,
    position,
    length: Math.max(0, end - position),
  };
};
