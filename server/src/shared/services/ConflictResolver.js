// Service responsible for transforming concurrent deltas so they apply consistently.
// Pure and stateless: it never mutates documents or rooms.
class ConflictResolver {

    transform(incomingDelta, appliedDelta) {
        let position = incomingDelta.position;
        let length = incomingDelta.length;

        const start = appliedDelta.position;
        const removed = appliedDelta.length || 0;
        const inserted = appliedDelta.text ? appliedDelta.text.length : 0;

        // 1. Transform position
        if (position >= start) {
            if (position >= start + removed) {
                position = position - removed + inserted;
            } else {
                position = start;
            }
        }

        // 2. Transform length (for deletions and replacements)
        if ((incomingDelta.type === "delete" || incomingDelta.type === "replace") && typeof length === "number") {
            const incomingStart = incomingDelta.position;
            const incomingEnd = incomingStart + length;

            if (appliedDelta.type === "insert") {
                // If insertion falls inside the deleted range, expand the delete length
                if (incomingStart < start && incomingEnd > start) {
                    length += inserted;
                }
            } else if (appliedDelta.type === "delete" || appliedDelta.type === "replace") {
                // If overlapping deletions, reduce the length by the intersection
                const appliedEnd = start + removed;
                const intersectionStart = Math.max(incomingStart, start);
                const intersectionEnd = Math.min(incomingEnd, appliedEnd);
                const intersectionLen = Math.max(0, intersectionEnd - intersectionStart);

                length -= intersectionLen;
            }
        }

        return {
            ...incomingDelta,
            position,
            ...(length !== undefined ? { length } : {}),
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

}

export default ConflictResolver;

