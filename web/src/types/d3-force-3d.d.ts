/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal ambient types for `d3-force-3d` (the dimension-agnostic d3-force fork
// that `force-graph`/`react-force-graph-2d` runs under the hood). It ships no
// declarations; we type only the builders GraphView uses to shape the layout.
declare module "d3-force-3d" {
  type Accessor<T> = number | ((node: any, i: number, nodes: any[]) => T);

  interface Force {
    (alpha: number): void;
    initialize?(nodes: any[], ...rest: any[]): void;
    strength(strength: Accessor<number>): this;
  }

  interface CollideForce extends Force {
    radius(radius: Accessor<number>): this;
    iterations(iterations: number): this;
  }

  interface PositionForce extends Force {
    x(x: Accessor<number>): this;
    y(y: Accessor<number>): this;
  }

  export function forceCollide(radius?: Accessor<number>): CollideForce;
  export function forceX(x?: Accessor<number>): PositionForce;
  export function forceY(y?: Accessor<number>): PositionForce;
  export function forceZ(z?: Accessor<number>): PositionForce;
  export function forceCenter(): Force;
  export function forceManyBody(): Force;
  export function forceLink(links?: any[]): LinkForce;

  interface LinkForce extends Force {
    id(id: (node: any, i: number, nodes: any[]) => string): this;
    distance(distance: Accessor<number>): this;
  }

  interface Simulation {
    force(name: string, force: Force): this;
    stop(): this;
    tick(iterations?: number): this;
  }

  export function forceSimulation(nodes?: any[], numDimensions?: 1 | 2 | 3): Simulation;
}
