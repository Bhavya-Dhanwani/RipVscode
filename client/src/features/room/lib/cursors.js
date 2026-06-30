// Remote cursor rendering for the Monaco editor.
//
// Each remote user is drawn with a Monaco content widget: a thin vertical caret
// in the user's color plus a floating name label above it. Content widgets let
// us style per-user inline (decorations only accept class names), so colors and
// labels need no global CSS injection.

// Shared palette — kept in sync with ParticipantsList so a participant's cursor
// matches their avatar color.
export const CURSOR_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
];

const hashCode = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
};

// Stable color for a given id (participant id or socket id).
export const cursorColorFor = (id) =>
  CURSOR_COLORS[hashCode(id || "") % CURSOR_COLORS.length];

// Create the DOM node for a remote cursor widget.
const buildCursorNode = (displayName, color, lineHeight) => {
  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.pointerEvents = "none";
  container.style.zIndex = "20";

  const caret = document.createElement("div");
  caret.style.position = "absolute";
  caret.style.top = "0";
  caret.style.left = "0";
  caret.style.width = "2px";
  caret.style.height = `${lineHeight}px`;
  caret.style.background = color;
  container.appendChild(caret);

  const label = document.createElement("div");
  label.textContent = displayName;
  label.style.position = "absolute";
  label.style.top = `-${Math.max(14, lineHeight - 4)}px`;
  label.style.left = "0";
  label.style.padding = "0 4px";
  label.style.borderRadius = "3px 3px 3px 0";
  label.style.background = color;
  label.style.color = "#ffffff";
  label.style.fontSize = "11px";
  label.style.lineHeight = "14px";
  label.style.fontFamily = "Inter, sans-serif";
  label.style.whiteSpace = "nowrap";
  container.appendChild(label);

  container._caret = caret;
  container._label = label;
  return container;
};

// Render or move a remote user's cursor. `state` is a plain object keyed by
// userId holding the live widgets for this editor.
export const renderRemoteCursor = (
  editor,
  monaco,
  state,
  { userId, offset, displayName, color }
) => {
  const model = editor?.getModel();
  if (!model || !monaco) return;

  const position = model.getPositionAt(offset);
  const lineHeight = editor.getOption(
    monaco.editor.EditorOption.lineHeight
  ) || 18;
  const safeColor = color || cursorColorFor(userId);
  const safeName = displayName || "Guest";

  let widget = state[userId];

  if (!widget) {
    const domNode = buildCursorNode(safeName, safeColor, lineHeight);
    widget = {
      _position: position,
      getId: () => `remote-cursor-${userId}`,
      getDomNode: () => domNode,
      getPosition: () => ({
        position: widget._position,
        preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
      }),
    };
    state[userId] = widget;
    editor.addContentWidget(widget);
  } else {
    // Update label text/color in case the display name changed.
    const node = widget.getDomNode();
    node._label.textContent = safeName;
    node._label.style.background = safeColor;
    node._caret.style.background = safeColor;
    widget._position = position;
    editor.layoutContentWidget(widget);
  }
};

// Remove a single remote user's cursor.
export const clearRemoteCursor = (editor, state, userId) => {
  const widget = state[userId];
  if (!editor || !widget) return;
  editor.removeContentWidget(widget);
  delete state[userId];
};

// Remove every remote cursor (used on teardown).
export const clearAllRemoteCursors = (editor, state) => {
  if (!editor) return;
  for (const userId of Object.keys(state)) {
    editor.removeContentWidget(state[userId]);
    delete state[userId];
  }
};
