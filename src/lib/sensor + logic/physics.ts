// location of sensor
export type Sensor = {
    x: number;
    y: number;
};

// values read from the different sensors
export type Forces = {
    F1: number;
    F2: number;
    F3: number;
};

// Location of the force, relative to the sensors
export type PressureCenter = {
    x: number;
    y: number;
    total: number;
};

// calculating the total force on the shelf
export function totalForce({ F1, F2, F3 }: Forces): number {
    return F1 + F2 + F3;
}

// find the location of the center of pressure, i.e the item itself
export function computePC(
    forces: Forces,
    sensors: [Sensor, Sensor, Sensor]
): PressureCenter | null {
    const { F1, F2, F3 } = forces;
    const total = F1 + F2 + F3;

    if (total <= 0) return null;

    const x = (F1 * sensors[0].x + F2 * sensors[1].x + F3 * sensors[2].x) / total;

    const y = (F1 * sensors[0].y + F2 * sensors[1].y + F3 * sensors[2].y) / total;

    return { x, y, total };
}

// helper to keep things within reasonable bounds
export function boundPC(
    PC: PressureCenter,
    width: number,
    height: number
): PressureCenter {
    return {
        ...PC,
        x: Math.max(0, Math.min(width, PC.x)),
        y: Math.max(0, Math.min(height, PC.y))
    };
}

export function smoothDt(prev: number, next: number, dt: number, tau = 0.2): number {
    const alpha = 1 - Math.exp(-dt / tau);
    return prev * (1 - alpha) + next * alpha;
}