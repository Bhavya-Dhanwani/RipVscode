"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useRouter } from "next/navigation";
import { socket } from "@/lib/socket";
import { getRoom } from "../api/room.api";
import {
  setRoom,
  clearRoom,
  addParticipant,
  removeParticipant,
} from "../state/roomSlice";
import { createDeltaFromChange, deltaToMonacoOperation } from "../lib/delta";

export function useCollaborativeEditor(roomCode) {
  const dispatch = useDispatch();
  const router = useRouter();
  const authUser = useSelector((state) => state.auth.user);

  const [document, setDocument] = useState(null);
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
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);

  // ── Editor mount: wire local edits → deltas → socket ──
  const handleEditorMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    changeDisposableRef.current = editor.onDidChangeModelContent((event) => {
      if (isApplyingRemoteRef.current) return;

      const orderedChanges = [...event.changes].sort(
        (a, b) => b.rangeOffset - a.rangeOffset
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

      // Emit cursor position after edits so others see updated position.
      const position = editor.getPosition();
      if (position) {
        const offset = editor.getModel().getOffsetAt(position);
        socket.emit("cursor-move", { roomCode, offset });
      }
    });

    // Track cursor movement (not just text changes).
    editor.onDidChangeCursorPosition((e) => {
      const offset = editor.getModel().getOffsetAt(e.position);
      socket.emit("cursor-move", { roomCode, offset });
    });
  }, [roomCode]);

  // ── Leave / End Session ──
  const leaveRoom = useCallback(() => {
    routerRef.current.push("/");
  }, []);

  // ── Kick ──
  const kickParticipant = useCallback((targetParticipantId) => {
    const me = participantRef.current;
    if (!me || me.role !== "HOST") return;

    socket.emit("kick-participant", {
      roomCode,
      hostParticipantId: me.id || me._id,
      targetParticipantId,
    });
  }, [roomCode]);

  // ── Main connection effect (deps: roomCode, dispatch ONLY) ──
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

    const handleDisconnect = () => setStatus("disconnected");

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
      }
    };

    const handleRoomClosed = (payload) => {
      setRoomClosed(true);
      setClosedBy(payload?.hostName || "The host");
    };

    const handleParticipantKicked = () => {
      routerRef.current.push("/");
    };

    // ── Remote cursors ──
    const decorationsRef = {};

    const handleRemoteCursor = ({ userId, offset }) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!model || !monacoRef.current) return;

      const position = model.getPositionAt(offset);

      // Remove old decoration for this user.
      if (decorationsRef[userId]) {
        editor.deltaDecorations(decorationsRef[userId], []);
      }

      // Add a cursor line decoration.
      const newDecorations = editor.deltaDecorations([], [
        {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column + 1,
          },
          options: {
            className: `remote-cursor-${userId.slice(0, 6)}`,
            stickiness: 1,
            hoverMessage: { value: `**User ${userId.slice(0, 6)}**` },
          },
        },
      ]);

      decorationsRef[userId] = newDecorations;
    };

    const handleCursorDisconnect = ({ userId }) => {
      const editor = editorRef.current;
      if (!editor || !decorationsRef[userId]) return;

      editor.deltaDecorations(decorationsRef[userId], []);
      delete decorationsRef[userId];
    };

    // ── Fetch room data, then connect ──
    const start = async () => {
      try {
        const res = await getRoom(roomCode);
        if (cancelled) return;

        const data = res.data.data;

        const me = data.participants.find(
          (p) => p.userId === authUserRef.current?.id
        );
        participantRef.current = me || null;

        versionRef.current = data.room.version ?? 1;

        dispatch(
          setRoom({
            roomDetails: data.room,
            participants: data.participants,
            currentParticipant: me || null,
          })
        );

        setDocument(data.room.document || "");
      } catch (error) {
        console.error("Failed to load room:", error);
        if (!cancelled) routerRef.current.push("/");
        return;
      }

      if (cancelled) return;

      // Register all listeners before connecting.
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

      if (participantRef.current) {
        socket.emit("leave-room", {
          roomCode,
          participantId: participantRef.current.id || participantRef.current._id,
        });
      }

      socket.disconnect();
      dispatch(clearRoom());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, dispatch]);

  return {
    document,
    status,
    roomClosed,
    closedBy,
    handleEditorMount,
    leaveRoom,
    kickParticipant,
  };
}

export default useCollaborativeEditor;
