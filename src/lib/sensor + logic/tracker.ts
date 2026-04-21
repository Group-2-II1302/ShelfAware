import { get } from 'svelte/store';
import { sensorData, Items, pendingScan, PC } from '../stores/shelf';

import { computePC } from './physics';
import { sensors } from './constants';

// internal state
let lastPC = null;
let lastTotal = 0;

const THRESHOLD = 0.05;

export function updateTracker() {

}

export function handleAdd() {

}

export function handleRemove() {

}

export function handleMove() {
    
}