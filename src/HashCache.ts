import Cache from './Cache';

export default class HashCache<KeyType, ValueType, HashType = string> {
    entries: Map<HashType, ValueType>;
    keysOrder: (HashType | null)[];
    maxSize: number | (() => number);
    keyHash: (key: KeyType) => HashType;

    constructor({
        maxSize = -1,
        keyHash = JSON.stringify as any
    }: {readonly maxSize?: number; readonly keyHash?: (key: KeyType) => HashType} = {}) {
        this.entries = new Map();
        this.keysOrder = [];
        this.maxSize = maxSize;
        this.keyHash = keyHash;
    }

    setEntry(key: KeyType, value: ValueType): void {
        const hash = this.keyHash(key);
        const {entries, keysOrder} = this;
        const maxSize = this.getMaxSize();
        if (maxSize >= 0 && entries.size >= maxSize) {
            // If the size is already at the maximum (or even exceeds it),
            // then delete the first entry that doesn't correspond to the new key
            // ("first" in insertion order).
            for (let i = 0, l = keysOrder.length; i < l; ++i) {
                const keyToDelete = keysOrder[i];
                if (keyToDelete && keyToDelete !== hash) {
                    entries.delete(keyToDelete);
                    keysOrder[i] = null;
                    break;
                }
            }
        }
        if (maxSize !== 0) {
            if (!entries.has(hash)) {
                keysOrder.push(hash);
            }
            entries.set(hash, value);
        }
    }

    getEntry<DefaultType>(key: KeyType): ValueType | typeof Cache.MISSING;
    getEntry<DefaultType>(key: KeyType, defaultValue: ValueType | DefaultType): ValueType | DefaultType;

    getEntry<DefaultType>(
        key: KeyType,
        defaultValue: ValueType | DefaultType = Cache.MISSING as any
    ): ValueType | DefaultType {
        const hash = this.keyHash(key);
        const {entries} = this;

        const entry = entries.get(hash);

        if (entry !== undefined) {
            return entry;
        }

        if (entries.has(hash)) {
            // There is a key, so the entry isn't missing, the value is just literally `undefined`.
            return entry as any;
        }

        return defaultValue;
    }

    empty(): void {
        this.entries.clear();
        this.keysOrder = [];
    }

    getSize(): number {
        return this.entries.size;
    }

    getMaxSize(): number {
        const maxSize = this.maxSize;
        return typeof maxSize === 'function' ? maxSize() : maxSize;
    }
}
