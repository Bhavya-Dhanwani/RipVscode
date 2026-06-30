// Service responsible for transforming concurrent deltas so they apply consistently.
// Pure and stateless: it never mutates documents or rooms.
//
// transform(a, b) returns `a` rebased so it can be applied on a document that
// has already had `b` applied. Calling it in both directions (a-after-b and
// b-after-a) with the same deterministic tie-break yields convergence (TP1)
// for the insert/delete/replace deltas this app produces.
class ConflictResolver {

    transform(incomingDelta, appliedDelta) {

        // Resolve the applied delta's footprint on the document.
        const start = appliedDelta.position;
        const removed = appliedDelta.length || 0;
        const inserted = appliedDelta.text ? appliedDelta.text.length : 0;

        // For concurrent inserts at the exact same caret, order them by site so
        // every peer agrees who ends up first. Without this, two same-position
        // inserts collapse onto each other.
        const tieAfter =
            removed === 0 &&
            this.compareSites(incomingDelta, appliedDelta) > 0;

        // Shift both ends of the incoming delta's range so its length stays valid
        // even when the applied delta deleted part of that range.
        const incomingLength = incomingDelta.length || 0;
        const position = this.shiftPosition(
            incomingDelta.position,
            start,
            removed,
            inserted,
            tieAfter
        );
        const end = this.shiftPosition(
            incomingDelta.position + incomingLength,
            start,
            removed,
            inserted,
            tieAfter
        );

        // Return a new delta with the adjusted position and clamped length.
        return {
            ...incomingDelta,
            position,
            length: Math.max(0, end - position),
        };

    }

    resolve(incomingDelta, appliedDeltas) {

        // Start from the original incoming delta.
        let transformed = incomingDelta;

        // Transform against each concurrent delta in application order.
        for (const appliedDelta of appliedDeltas) {
            transformed = this.transform(transformed, appliedDelta);
        }

        // Return the fully transformed delta.
        return transformed;

    }

    shiftPosition(position, start, removed, inserted, tieAfter) {

        // Positions strictly before the change are unaffected.
        if (position < start) {
            return position;
        }

        // Positions after the affected range shift by the net length change.
        if (position > start) {
            if (position >= start + removed) {
                return position - removed + inserted;
            }
            // Positions inside a removed range collapse to the change start.
            return start;
        }

        // position === start.
        // A deletion starting here leaves the left boundary in place.
        if (removed > 0) {
            return start;
        }

        // A concurrent insert here: order is decided by the tie-break.
        return tieAfter ? start + inserted : start;

    }

    // Deterministic total order over two deltas, used to break insert ties.
    // Both peers compare the same two deltas, so they agree on the ordering.
    compareSites(a, b) {

        const ua = a.userId ?? "";
        const ub = b.userId ?? "";
        if (ua < ub) return -1;
        if (ua > ub) return 1;

        // Same site (or both anonymous): fall back to the stable delta id.
        const ia = a.id ?? "";
        const ib = b.id ?? "";
        if (ia < ib) return -1;
        if (ia > ib) return 1;
        return 0;

    }

}

export default ConflictResolver;
