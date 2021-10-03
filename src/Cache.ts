function equals(a, b) {
    return a === b;
}

export default class Cache {
    entries: any[];
    maxSize: number | (() => number);
    keyComparator: (a: any, b: any) => boolean;

    static MISSING = {};

    constructor({
        maxSize = -1,
        keyComparator = equals
    }: {maxSize?: number | (() => number); keyComparator?: (a: any, b: any) => boolean} = {}) {
        this.entries = [];
        this.maxSize = maxSize;
        this.keyComparator = keyComparator;
    }

    setEntry(key, value) {
        const existingIndex = this._findEntry(key);
        if (existingIndex >= 0) {
            this.entries[existingIndex].value = value;
        } else {
            // Add a new entry to the front, since there is no entry for the given key yet.
            const maxSize = this.getMaxSize();
            if (maxSize !== 0) {
                this.entries.unshift({key, value});
            }
            if (maxSize >= 0 && this.entries.length > maxSize) {
                // If we exceed the maximum cache size, remove the last entry.
                this.entries.pop();
            }
        }
    }

    getEntry(key, defaultValue = Cache.MISSING) {
        const index = this._findEntry(key);
        if (index >= 0) {
            return this.entries[index].value;
        } else {
            return defaultValue;
        }
    }

    getSize() {
        return this.entries.length;
    }

    empty() {
        this.entries = [];
    }

    getMaxSize() {
        const maxSize = this.maxSize;
        return typeof maxSize === 'function' ? maxSize() : maxSize;
    }

    _findEntry(key) {
        const {entries, keyComparator} = this;
        for (let i = 0, l = entries.length; i < l; ++i) {
            const entry = entries[i];
            if (keyComparator(key, entry.key)) {
                return i;
            }
        }
        return -1;
    }
}
