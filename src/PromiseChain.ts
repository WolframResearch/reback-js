import SyncPromise from 'sync-promise-js';

export default class PromiseChain {
    chain: SyncPromise<void>;

    static whenDone<T>(promiseFunc: () => SyncPromise<T>) {
        return SyncPromise.defer().then(() => {
            const promise = promiseFunc();
            if (promise.isSettled()) {
                return SyncPromise.resolve();
            } else {
                return promise.then(() => {
                    return PromiseChain.whenDone(promiseFunc);
                });
            }
        });
    }

    constructor() {
        this.chain = SyncPromise.resolve();
    }

    add<T>(task: () => SyncPromise<T>) {
        this.chain = this.chain.then(task);
        return this.chain;
    }

    get() {
        return this.chain;
    }

    isSettled() {
        return this.chain.isSettled();
    }

    whenDone() {
        return PromiseChain.whenDone(this.get.bind(this));
    }
}
