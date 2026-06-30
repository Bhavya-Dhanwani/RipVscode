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
import {
  createDeltaFromChange,
  deltaToMonacoOperation,
  transformDelta,
} from "../lib/delta";
import {
  cursorColorFor,
  renderRemoteCursor,
  clearRemoteCursor,
  clearAllRemoteCursors,
} from "../lib/cursors";

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
  // OT client state: last server version we are synced to, the single delta in
  // flight awaiting an ack, and the queue of local deltas not yet sent.
  const revisionRef = useRef(1);
  const outstandingRef = useRef(null);
  const pendingRef = useRef([]);
  const isApplyingRemoteRef = useRef(false);
  const changeDisposableRef = useRef(null);
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);

  // Send a delta to the server, stamping it with the version it is based on.
  // The base version is read at send time so a delta that waited in the queue
  // is tagged with the revision that actually preceded it.
  const sendDelta = useCallback((delta) => {
    const toSend = { ...delta, version: revisionRef.current };
    outstandingRef.current = toSend;
    socket.emit("code-change", { roomCode, delta: toSend });
  }, [roomCode]);

  // Queue a local edit: send immediately when nothing is in flight, otherwise
  // buffer it until the outstanding delta is acknowledged.
  const queueLocalDelta = useCallback((delta) => {
    if (outstandingRef.current === null) {
      sendDelta(delta);
    } else {
      pendingRef.current.push(delta);
    }
  }, [sendDelta]);

  // Emit this client's cursor position with identity so peers can label it.
  const emitCursor = useCallback((editor) => {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return;

    const me = participantRef.current;
    const offset = model.getOffsetAt(position);
    socket.emit("cursor-move", {
      roomCode,
      offset,
      displayName: me?.displayName || "Guest",
      color: cursorColorFor(me?.id || me?._id || ""),
    });
  }, [roomCode]);

  // ── Editor mount: wire local edits → deltas → socket ──
  const handleEditorMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    changeDisposableRef.current = editor.onDidChangeModelContent((event) => {
      if (isApplyingRemoteRef.current) return;

      // Apply highest-offset changes first so lower-offset positions in the same
      // event stay valid; queue each as an independent local delta.
      const orderedChanges = [...event.changes].sort(
        (a, b) => b.rangeOffset - a.rangeOffset
      );

      for (const change of orderedChanges) {
        const delta = createDeltaFromChange(change, {
          version: 0,
          userId: authUserRef.current?.id,
        });
        if (!delta) continue;

        queueLocalDelta(delta);
      }

      // Emit cursor position after edits so others see updated position.
      emitCursor(editor);
    });

    // Track cursor movement (not just text changes).
    editor.onDidChangeCursorPosition(() => {
      emitCursor(editor);
    });
  }, [queueLocalDelta, emitCursor]);

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

    // Per-user remote cursor widgets for this editor, keyed by participant id.
    const cursorState = {};

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

    // The server acknowledges our own edits so we can advance our revision and
    // release the next buffered local delta.
    const handleAck = ({ version }) => {
      revisionRef.current = version;
      const next = pendingRef.current.shift();
      if (next) {
        sendDelta(next);
      } else {
        outstandingRef.current = null;
      }
    };

    const handleRemoteChange = ({ delta, version }) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!model) return;

      // Collect our un-acked local edits in sequence (outstanding first).
      const local = [];
      if (outstandingRef.current) local.push(outstandingRef.current);
      for (const op of pendingRef.current) local.push(op);

      // Rebase the incoming op past each local op, and each local op past the
      // incoming op, so both sides converge on the same document (TP1).
      let incoming = delta;
      const rebasedLocal = [];
      for (const localOp of local) {
        rebasedLocal.push(transformDelta(localOp, incoming));
        incoming = transformDelta(incoming, localOp);
      }

      // Apply the fully-transformed incoming op to our document.
      isApplyingRemoteRef.current = true;
      try {
        const operation = deltaToMonacoOperation(incoming, model);
        editor.executeEdits("remote", [operation]);
      } finally {
        isApplyingRemoteRef.current = false;
      }

      // Store the rebased local ops back into outstanding/pending.
      if (outstandingRef.current) {
        outstandingRef.current = rebasedLocal[0] ?? null;
        pendingRef.current = rebasedLocal.slice(1);
      } else {
        pendingRef.current = rebasedLocal;
      }

      revisionRef.current = version;
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

      // Drop any in-flight/buffered local edits; the document was fully reset.
      revisionRef.current = version;
      outstandingRef.current = null;
      pendingRef.current = [];
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
        // Clear their caret too (covers explicit leave, not just disconnect).
        clearRemoteCursor(editorRef.current, cursorState, participantId);
      }
    };

    const handleRoomClosed = (payload) => {
      setRoomClosed(true);
      setClosedBy(payload?.hostName || "The host");
    };

    const handleParticipantKicked = () => {
      routerRef.current.push("/");
    };

    // ── Remote cursors ── (per-user content widgets keyed by participant id)
    const handleRemoteCursor = ({ userId, offset, displayName, color }) => {
      const editor = editorRef.current;
      if (!editor || !monacoRef.current) return;

      renderRemoteCursor(editor, monacoRef.current, cursorState, {
        userId,
        offset,
        displayName,
        color,
      });
    };

    const handleCursorDisconnect = ({ userId }) => {
      clearRemoteCursor(editorRef.current, cursorState, userId);
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

        revisionRef.current = data.room.version ?? 1;
        outstandingRef.current = null;
        pendingRef.current = [];

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
      socket.on("code-ack", handleAck);
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
      socket.off("code-ack", handleAck);
      socket.off("sync-required", handleSyncRequired);
      socket.off("participant-joined", handleParticipantJoined);
      socket.off("participant-left", handleParticipantLeft);
      socket.off("participant-kicked", handleParticipantKicked);
      socket.off("room-closed", handleRoomClosed);
      socket.off("remote-cursor", handleRemoteCursor);
      socket.off("cursor-disconnect", handleCursorDisconnect);

      // Tear down any remaining remote cursor widgets.
      clearAllRemoteCursors(editorRef.current, cursorState);

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
