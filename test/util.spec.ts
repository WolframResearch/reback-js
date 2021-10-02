import {mergeSortedArrays} from '../src/util';

describe('Reback utils', () => {
    describe('mergeSortedArrays', () => {
        it('merges arrays in sorted order', () => {
            const target = [1, 3, 5];
            const source = [0, 2];
            mergeSortedArrays(target, source);
            expect(target).toEqual([0, 1, 2, 3, 5]);
        });
        it('unifies duplicates', () => {
            const target = [1, 2, 3];
            const source = [2, 4, 5];
            mergeSortedArrays(target, source);
            expect(target).toEqual([1, 2, 3, 4, 5]);
        });
        it('handles the case of the last target value being equal to a source value', () => {
            const target = [1, 2, 3];
            const source = [3, 4, 5];
            mergeSortedArrays(target, source);
            expect(target).toEqual([1, 2, 3, 4, 5]);
        });
        it('accepts an empty target', () => {
            const target = [];
            const source = [1, 2, 3];
            mergeSortedArrays(target, source);
            expect(target).toEqual([1, 2, 3]);
        });
        it('accepts an empty source', () => {
            const target = [1, 2, 3];
            const source = [];
            mergeSortedArrays(target, source);
            expect(target).toEqual([1, 2, 3]);
        });
    });
});
