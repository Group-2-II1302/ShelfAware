import { get } from 'svelte/store';
import { sensorData, Items, pendingScan, PC } from '../stores/shelf';

import { computePC } from './physics';
import { sensors } from './constants';

// internal state
let lastPC = null;
let lastTotal = 0;

let pendningRM = null;
let RMTimer = null;

const THRESHOLD = 0.05;
const mvTimer = 2000; // ms

export function updateTracker() {
    const { F1, F2, F3 } = get(sensorData);
    const pendingId = get(pendingScan);

    const currPC = computePC({ F1, F2, F3 }, sensors);

    if (!currPC) return;

    PC.set(currPC);
    const deltaF = currPC.total - lastPC;

    // Item added case (time buffer to-be-added)
    if (deltaF > THRESHOLD && pendingScan) {
        handleAdd(pendingId, currPC, deltaF);
        pendingScan.set(null);
    }

    // Item removed case (time buffer to-be-added)
    if (deltaF < -THRESHOLD) {
        handleRemove(Math.abs(deltaF));
    }

    // Item moved case (fell over, moved by another item or a person briefly lifts an item and places it somehwere else)
    else {
        handleMove(currPC);
    }

    lastPC = currPC;
    lastTotal = currPC.total;
}

export function handleAdd(id, currentPC, dF) {
    Items.update(list => [
        ...list,
        {
            id,
            dF,
            position: {
                x: currentPC.x,
                y: currentPC.y
            }
        }
    ]);
}

export function handleRemove(rmDF) {
    Items.update(list => {
        if (list.length === 0) return list;

        let bestIndx = 0;
        let bestDiff = Infinity;

        for (let i = 0; i < list.length; i++) {
            const diff = Math.abs(list[i].weight - rmDF);

            if (diff < bestDiff) {
                bestDiff = diff;
                bestIndx = i;
            }
        }

        list.splice(bestIndx, 1);
        return [...list];
    });
}

export function handleMove(PC) {
    if (!lastPC) return;

    const movement = Math.hypot(
        PC.x - lastPC.x,
        PC.y - lastPC.y
    );

    if (movement < 0.01) return;

    Items.update(list => {
        if (list.length === 0) return list;

        let bestIdx = 0;
        let bestDist = Infinity;

        for (let i = 0; i < list.length; i++){
            const itm = list[i];

            const dist = Math.hypot(
                itm.position.x - - PC.x,
                itm.position.y - PC.y
            );

            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        list[bestIdx].position = {
            x: PC.x,
            y: PC.y
        }

        return [...list];
    });
}