import Cache from '../datastructures/Cache';

/**
 * A cache that can store (up to) a single entry.
 */
export default class SingleEntryCache<Key, Value> {
    /** Hash of the key of the stored entry. `null` means there is no entry. */
    keyHash: string | null;

    /** Cached value. */
    value: Value | null;

    /** Function to determine the hash of a given key. */
    getKeyHash: (k: Key) => string;

    constructor({keyHash = JSON.stringify}: {keyHash?: (k: Key) => string} = {}) {
        this.keyHash = null;
        this.value = null;
        this.getKeyHash = keyHash;
    }

    setEntry(key: Key, value: Value) {
        this.keyHash = this.getKeyHash(key);
        this.value = value;
    }

    getEntry(key: Key, defaultValue: Value = Cache.MISSING as any): Value | typeof Cache.MISSING {
        if (this.keyHash === null) {
            return defaultValue;
        }
        const hash = this.getKeyHash(key);
        if (hash === this.keyHash) {
            return this.value as Value;
        }
        return defaultValue;
    }

    empty() {
        this.keyHash = null;
        this.value = null;
    }

    getSize() {
        if (this.keyHash === null) {
            return 0;
        }
        return 1;
    }

    getMaxSize() {
        return 1;
    }
}
