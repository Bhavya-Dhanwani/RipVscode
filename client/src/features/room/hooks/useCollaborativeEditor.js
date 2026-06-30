"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useRouter } from "next/navigation";
import { socket } from "@/lib/socket";
import { getRoom, joinRoom as joinRoomApi } from "../api/room.api";
import {
  setRoom,
  clearRoom,
  addParticipant,
  removeParticipant,
  setTypingStatus,
} from "../state/roomSlice";
import { createDeltaFromChange, deltaToMonacoOperation } from "../lib/delta";

// Unique color assigned to each remote cursor.
const CURSOR_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
];
let colorIndex = 0;
const userColorMap = new Map();
function getColorForUser(userId) {
  if (!userColorMap.has(userId)) {
    userColorMap.set(userId, CURSOR_COLORS[colorIndex % CURSOR_COLORS.length]);
    colorIndex++;
  }
  return userColorMap.get(userId);
}

export function useCollaborativeEditor(roomCode) {
  const dispatch = useDispatch();
  const router = useRouter();
  const authUser = useSelector((state) => state.auth.user);

  const [editorDocument, setEditorDocument] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [roomClosed, setRoomClosed] = useState(false);
  const [closedBy, setClosedBy] = useState("");

  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const participantRef = useRef(null);
  const authUserRef = useRef(authUser);
  const versionRef = useRef(1);
  const isApplyingRemoteRef = useRef(false);
  const changeDisposableRef = useRef(null);

  // Remote cursors
  const remoteCursorsRef = useRef(new Map());
  const cursorDecorationsRef = useRef([]);

  // Typing
  const typingTimeoutRef = useRef(null);

  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);

  // Update Monaco decorations to reflect all remote cursors.
  const updateCursorDecorations = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!model) return;

    const newDecorations = [];
    remoteCursorsRef.current.forEach((data, userId) => {
      if (data.offset == null) return;
      const color = data.color || "#ef4444";
      const label = data.displayName || userId.slice(0, 6);

      const pos = model.getPositionAt(data.offset);
      if (!pos) return;

      // Vertical line at cursor position
      newDecorations.push({
        range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column + 1 },
        options: {
          className: `remote-cursor-${userId}`,
          beforeContentClassName: `remote-cursor-line`,
          stickiness: 1,
          hoverMessage: { value: `**${label}**` },
        },
      });

      // Name label above cursor
      newDecorations.push({
        range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column },
        options: {
          afterContentClassName: `remote-cursor-label`,
          stickiness: 1,
          after: { content: ` ${label}`, inlineClassName: `cursor-label-text`, color: color },
        },
      });
    });

    cursorDecorationsRef.current = editor.deltaDecorations(cursorDecorationsRef.current, newDecorations);
  }, []);

  // Emit cursor position on editor changes and cursor position changes.
  const handleEditorMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // Register cursor label CSS in the editor
      const styleEl = document.createElement("style");
      styleEl.textContent = `
        .remote-cursor-line { border-left: 2px solid; margin-left: -1px; }
        .remote-cursor-label {
          position: relative; z-index: 10; pointer-events: none;
        }
        .cursor-label-text {
          font-size: 11px; font-weight: 600; padding: 1px 4px;
          border-radius: 3px; margin-left: 2px;
          white-space: nowrap; position: relative; top: -4px;
        }
      `;
      document.head.appendChild(styleEl);

      // Emit code deltas and typing indicator on content change.
      changeDisposableRef.current = editor.onDidChangeModelContent((event) => {
        if (isApplyingRemoteRef.current) return;

        const orderedChanges = [...event.changes].sort(
          (a, b) => b.rangeOffset - a.rangeOffset,
        );

        for (const change of orderedChanges) {
          const delta = createDeltaFromChange(change, {
            version: versionRef.current,
            userId: authUserRef.current?.id,
          });
          if (!delta) continue;

          socket.emit("code-change", { roomCode, delta });
          versionRef.current += 1;
        }

        // Emit typing indicator
        const me = participantRef.current;
        if (me) {
          socket.emit("typing-start", {
            roomCode,
            participantId: me.id || me._id,
            displayName: me.displayName,
          });

          clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = setTimeout(() => {
            socket.emit("typing-stop", {
              roomCode,
              participantId: me.id || me._id,
            });
          }, 1500);
        }

        // Emit cursor position
        const posModel = editor.getModel();
        const position = editor.getPosition();
        if (position && posModel) {
          const offset = posModel.getOffsetAt(position);
          socket.emit("cursor-move", { roomCode, offset });
        }
      });

      // Emit cursor position on cursor position change (no typing).
      editor.onDidChangeCursorPosition((e) => {
        const model = editor.getModel();
        if (!model) return;
        const position = editor.getPosition();
        if (position) {
          const offset = model.getOffsetAt(position);
          socket.emit("cursor-move", { roomCode, offset });
        }
      });
    },
    [roomCode],
  );

  const leaveRoom = useCallback(() => {
    const participant = participantRef.current;
    if (participant?.role === "HOST") {
      socket.emit("end-session", {
        roomCode,
        hostName: participant.displayName,
      });
    }
    router.push("/");
  }, [roomCode, router]);

  const kickParticipant = useCallback(
    (targetParticipantId) => {
      const me = participantRef.current;
      if (!me || me.role !== "HOST") return;
      socket.emit("kick-participant", {
        roomCode,
        hostParticipantId: me.id || me._id,
        targetParticipantId,
      });
    },
    [roomCode],
  );

  useEffect(() => {
    if (!roomCode) return;

    let cancelled = false;

    const handleConnect = () => {
      setStatus("connected");
      if (participantRef.current) {
        socket.emit("join-room", {
          roomCode,
          participant: participantRef.current,
        });
      }
    };

    const handleDisconnect = () => {
      setStatus("disconnected");
    };

    const handleRemoteChange = ({ delta, version }) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!model) return;

      isApplyingRemoteRef.current = true;
      try {
        const operation = deltaToMonacoOperation(delta, model);
        editor.executeEdits("remote", [operation]);
      } finally {
        isApplyingRemoteRef.current = false;
      }

      versionRef.current = version;
    };

    const handleSyncRequired = ({ version, document: latestDocument }) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!model) return;

      isApplyingRemoteRef.current = true;
      try {
        model.setValue(latestDocument);
      } finally {
        isApplyingRemoteRef.current = false;
      }

      versionRef.current = version;
    };

    const handleParticipantJoined = (participant) => {
      if (participant?.id || participant?._id) {
        dispatch(addParticipant(participant));
      }
    };

    const handleParticipantLeft = (payload) => {
      const participantId = payload?.participantId;
      if (participantId) {
        dispatch(removeParticipant(participantId));
        // Clean up remote cursor
        remoteCursorsRef.current.delete(participantId);
        updateCursorDecorations();
        dispatch(setTypingStatus({ participantId, isTyping: false }));
      }
    };

    const handleRoomClosed = (payload) => {
      setRoomClosed(true);
      setClosedBy(payload?.hostName || "The host");
    };

    const handleParticipantKicked = () => {
      router.push("/");
    };

    // Remote cursor moved
    const handleRemoteCursor = ({ userId, offset, displayName }) => {
      const color = getColorForUser(userId);
      remoteCursorsRef.current.set(userId, { offset, color, displayName });
      updateCursorDecorations();
    };

    // Remote cursor disconnected
    const handleCursorDisconnect = ({ userId }) => {
      remoteCursorsRef.current.delete(userId);
      updateCursorDecorations();
    };

    // Remote typing started
    const handleTypingStart = ({ participantId }) => {
      dispatch(setTypingStatus({ participantId, isTyping: true }));
    };

    // Remote typing stopped
    const handleTypingStop = ({ participantId }) => {
      dispatch(setTypingStatus({ participantId, isTyping: false }));
    };

    const start = async () => {
      try {
        const res = await getRoom(roomCode);
        if (cancelled) return;

        const data = res.data.data;

        let me = data.participants.find(
          (participant) => participant.userId === authUserRef.current?.id,
        );

        if (!me && authUserRef.current) {
          try {
            await joinRoomApi({
              roomCode,
              displayName: authUserRef.current.username,
              userId: authUserRef.current.id,
            });

            const freshRes = await getRoom(roomCode);
            const freshData = freshRes.data.data;
            data.participants = freshData.participants;

            me = data.participants.find(
              (participant) => participant.userId === authUserRef.current?.id,
            );
          } catch (joinError) {
            console.error("Auto-join failed:", joinError);
          }
        }

        participantRef.current = me || null;
        versionRef.current = data.room.version ?? 1;

        dispatch(
          setRoom({
            roomDetails: data.room,
            participants: data.participants,
            currentParticipant: me || null,
          }),
        );

        setEditorDocument(data.room.document || "");
      } catch (error) {
        console.error("Failed to load room:", error);
        if (!cancelled) router.push("/");
        return;
      }

      if (cancelled) return;

      socket.on("connect", handleConnect);
      socket.on("disconnect", handleDisconnect);
      socket.on("code-change", handleRemoteChange);
      socket.on("sync-required", handleSyncRequired);
      socket.on("participant-joined", handleParticipantJoined);
      socket.on("participant-left", handleParticipantLeft);
      socket.on("participant-kicked", handleParticipantKicked);
      socket.on("room-closed", handleRoomClosed);
      socket.on("remote-cursor", handleRemoteCursor);
      socket.on("cursor-disconnect", handleCursorDisconnect);
      socket.on("typing-start", handleTypingStart);
      socket.on("typing-stop", handleTypingStop);

      if (socket.connected) {
        handleConnect();
      } else {
        socket.connect();
      }
    };

    start();

    return () => {
      cancelled = true;

      if (changeDisposableRef.current) {
        changeDisposableRef.current.dispose();
        changeDisposableRef.current = null;
      }

      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("code-change", handleRemoteChange);
      socket.off("sync-required", handleSyncRequired);
      socket.off("participant-joined", handleParticipantJoined);
      socket.off("participant-left", handleParticipantLeft);
      socket.off("participant-kicked", handleParticipantKicked);
      socket.off("room-closed", handleRoomClosed);
      socket.off("remote-cursor", handleRemoteCursor);
      socket.off("cursor-disconnect", handleCursorDisconnect);
      socket.off("typing-start", handleTypingStart);
      socket.off("typing-stop", handleTypingStop);

      if (participantRef.current) {
        socket.emit("leave-room", {
          roomCode,
          participantId: participantRef.current.id,
        });
      }

      socket.disconnect();
      dispatch(clearRoom());
    };
  }, [roomCode, dispatch, router, updateCursorDecorations]);

  return {
    document: editorDocument,
    status,
    roomClosed,
    closedBy,
    handleEditorMount,
    leaveRoom,
    kickParticipant,
  };
}

export default useCollaborativeEditor;
