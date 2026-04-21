import { writable } from 'svelte/store';

export type sensorData = {
    F1: number;
    F2: number;
    F3: Number;
};

export const sensorData = writable<sensorData>({
    F1: 0,
    F2: 0,
    F3: 0
});

export type shelfItem = {
    id: string;
    weight: number;
    position: {
        x: number;
        y: number;
    };
}

export const Items = writable<shelfItem[]>([]);

export const pendingScan = writable<string | null>(null);

export type PC = {
    x: number;
    y: number;
    total: number;
};

export const PC = writable<PC | null>(null);