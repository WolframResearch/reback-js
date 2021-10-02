import {PROFILE_REBACK, IS_SERVER} from "./globals";

const performance = PROFILE_REBACK && !IS_SERVER && typeof window !== 'undefined' ? window.performance : null;

let eventID: number = 0;

function createMark(name: string): void {
    if (performance) {
        performance.clearMarks(name);
        performance.mark(name);
    }
}

function createMeasure(name: string, startMark: string, endMark: string): void {
    if (performance) {
        performance.measure(name, startMark, endMark);
    }
}

export function dispatchProfileEvent(value: any | null | undefined): number {
    if (PROFILE_REBACK) {
        const id = eventID++;

        window.dispatchEvent(
            new CustomEvent('profile', {
                detail: {id, value}
            })
        );

        return id;
    }
    return -1;
}

export function start(name: string): void {
    createMark(`${name}-start`);
}

export function end(name: string) {
    if (performance) {
        const startMark = `${name}-start`;
        const endMark = `${name}-end`;

        createMark(endMark);
        createMeasure(name, startMark, endMark);
    }
}

export function mark(name: string) {
    if (console.timeStamp) {
        console.timeStamp(name);
    }
}

export function count(name: string) {
    if (console.count) {
        console.count(name);
    }
}

if (PROFILE_REBACK && typeof window !== 'undefined') {
    class Intervals {
        intervals: Array<[number, number]> = [];

        add(x, y) {
            let newStart = x;
            let newEnd = y;
            this.intervals.forEach(([a, b], index) => {
                if (a >= newStart && b <= newEnd) {
                    // The existing interval is entirely inside the new one. Remove the existing one.
                    this.intervals[index] = [a, a];
                } else if (a < newStart && newStart < b && b < newEnd) {
                    // The end point of the existing interval is inside the new one. Set the new one start at that end.
                    newStart = b;
                } else if (newStart < a && a < newEnd && b > newEnd) {
                    // The start point of the existing interval is inside the new one. Make the new end at that start.
                    newEnd = a;
                }
            });
            if (newEnd > newStart) {
                this.intervals.push([newStart, newEnd]);
            }
        }

        getNonOverlapping() {
            return this.intervals.reduce((total, [a, b]) => total + b - a, 0);
        }
    } // eslint-disable-next-line no-underscore-dangle

    (window as any)._getProfileTimings = () => {
        const measures = window.performance.getEntriesByType('measure');
        const timings = {};
        for (const measure of measures) {
            timings[measure.name] = (timings[measure.name] || 0) + measure.duration;
        }
        return timings;
    };

    // eslint-disable-next-line no-underscore-dangle
    (window as any)._getNonOverlappingTimings = () => {
        const measures = window.performance.getEntriesByType('measure');
        const timings: Record<string, Intervals> = {};

        for (const measure of measures) {
            let intervals = timings[measure.name];
            if (!intervals) {
                intervals = timings[measure.name] = new Intervals();
            }
            intervals.add(measure.startTime, measure.startTime + measure.duration);
        }

        const result = {};
        Object.keys(timings).forEach(name => {
            const intervals = timings[name];
            result[name] = intervals.getNonOverlapping();
        });
        return result;
    };
}
