/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ClipPath as ClipPathElement } from '@diffusionstudio/reconciler';
import {
	Computed,
	Flip,
	Source,
	Tool,
	ToolType,
	decompose2D,
	entityPivot,
	entityOffset,
	entityWorldMat,
	getEntityTree,
	getIntrinsicPaint,
	getParentEntity,
	getSelection,
	invert2D,
	isMaskContainer,
	isShape,
	multiply2D,
	store,
	translate2D,
} from '@diffusionstudio/runtime';
import { createSignal } from 'solid-js';

import { getDocumentEditor } from './editor';
import { editTransform } from './input/interactions';

import type { Entity, World } from 'koota';
import type { TransformWrite } from './input/interactions';

const round2 = (value: number): number => Math.round(value * 100) / 100;

// The node the tool is aimed at, reactive so the bar follows it.
const [clipPathTarget, setClipPathTarget] = createSignal<Entity | null>(null);

/** The node the picked shapes will clip, reactive; null while the tool is down. */
export { clipPathTarget };

export function getClipPathTarget(): Entity | null {
	const target = clipPathTarget();
	return target?.isAlive() ? target : null;
}

/** Picks the tool to add clip paths to `target`. The selection stays on it until a shape is picked. */
export function beginClipPathFor(world: World, target: Entity): void {
	setClipPathTarget(target);
	world.set(Tool, { value: ToolType.CLIP_PATH });
}

/** Forgets the target: the tool is down. */
export function clearClipPathTarget(): void {
	setClipPathTarget(null);
}

/**
 * Whether `entity` can clip `target`: a plain shape (what a `<clipPath>`
 * clips by is `<rect>`, `<ellipse>`, `<polygon>` or `<path>`, so media, text
 * and containers are out), not cutting something already, and not the target
 * or something the target sits inside — a node cannot be moved into its own
 * subtree.
 */
export function canClipWith(world: World, target: Entity, entity: Entity): boolean {
	if (entity === target || !entity.isAlive() || !entity.get(Source)?.value) return false;
	if (!isShape(entity) || getIntrinsicPaint(entity) !== undefined) return false;
	const parent = getParentEntity(entity);
	if (parent && isMaskContainer(parent)) return false;
	return !getEntityTree(world, entity).includes(target);
}

/** The selected shapes Confirm would apply to the target, in selection order. */
export function getClipPathPicks(world: World): Entity[] {
	const target = getClipPathTarget();
	if (!target) return [];
	return getSelection(world).filter((entity) => canClipWith(world, target, entity));
}

/**
 * Gives the target a new `<clipPath>` holding the picked shapes, one undo
 * step, and puts the tool down with the target selected: the target then
 * shows only inside their outlines together, and within any clip path it had
 * before. Each shape keeps its place on the canvas: its matrix is carried
 * from the parent it had into the target's space (the clip path's) and
 * written back as `x`, `y` and `rotation`, with whatever scale the move adds
 * (a target drawn at half size, say) folded into its `width` and `height`
 * rather than its own scale.
 */
export function applyClipPaths(world: World): void {
	const target = getClipPathTarget();
	const picks = getClipPathPicks(world);
	if (!target || picks.length === 0) return;

	const editor = getDocumentEditor(world);
	const computed = store(world, Computed);
	const flip = store(world, Flip);
	const targetInverse = invert2D(entityWorldMat(world, target));

	const [clipPath] = editor.insertElement(target, () => <ClipPathElement />);
	if (!clipPath) {
		leaveClipPathTool(world, target);
		return;
	}

	let moved = 0;
	for (const shape of picks) {
		const eid = shape.id();
		const width = computed.width[eid] ?? 0;
		const height = computed.height[eid] ?? 0;
		const pivot = entityPivot(world, shape);

		// Where it is drawn now, pivot folded in (see `bakeContainerInto`),
		// taken into the target's space (which the clip path shares) before
		// the move changes its parent.
		const placed = decompose2D(multiply2D(
			targetInverse,
			multiply2D(entityWorldMat(world, shape), translate2D(pivot.x, pivot.y)),
		));

		if (!editor.reparent(shape, clipPath)) continue;
		moved++;

		// The scale the shape carries of its own stays its own; the rest is the move's.
		const ownX = (computed.scaleX[eid] ?? 1) * (flip.x[eid] ?? 1);
		const ownY = (computed.scaleY[eid] ?? 1) * (flip.y[eid] ?? 1);
		const nextWidth = ownX === 0 ? width : Math.round(width * Math.abs(placed.scaleX / ownX));
		const nextHeight = ownY === 0 ? height : Math.round(height * Math.abs(placed.scaleY / ownY));

		const offset = entityOffset(world, shape);
		const nextPivot = entityPivot(world, shape, nextWidth, nextHeight);
		const x = Math.round(placed.x - nextPivot.x - offset.x);
		const y = Math.round(placed.y - nextPivot.y - offset.y);
		const rotation = round2(placed.rotation);

		const writes: TransformWrite[] = [];
		if (x !== Math.round(computed.positionX[eid] ?? 0)) writes.push(['x', x]);
		if (y !== Math.round(computed.positionY[eid] ?? 0)) writes.push(['y', y]);
		if (rotation !== round2(computed.rotation[eid] ?? 0)) writes.push(['rotation', rotation]);
		if (nextWidth !== Math.round(width)) writes.push(['width', nextWidth]);
		if (nextHeight !== Math.round(height)) writes.push(['height', nextHeight]);
		if (writes.length) editTransform(world, editor, shape, writes);
	}

	// An empty clip path would clip nothing; it is not worth the file.
	if (moved === 0) editor.remove(clipPath);

	leaveClipPathTool(world, target);
}

/** Puts the tool down without applying anything; the selection goes back to the target. */
export function cancelClipPath(world: World): void {
	leaveClipPathTool(world, getClipPathTarget());
}

function leaveClipPathTool(world: World, target: Entity | null): void {
	clearClipPathTarget();
	if (target) getDocumentEditor(world).select(target);
	if (world.get(Tool)?.value === ToolType.CLIP_PATH) world.set(Tool, { value: ToolType.MOVE });
}
