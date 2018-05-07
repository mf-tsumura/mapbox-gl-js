// @flow

import ShelfPack from '@mapbox/shelf-pack';

import { RGBAImage } from '../util/image';
import { register } from '../util/web_worker_transfer';

import type {StyleImage} from '../style/style_image';

const padding = 1;

type Rect = {
    x: number,
    y: number,
    w: number,
    h: number
};

export class ImagePosition {
    paddedRect: Rect;
    pixelRatio: number;

    constructor(paddedRect: Rect, {pixelRatio}: StyleImage) {
        const {x, y, w, h} = paddedRect;
        this.paddedRect = {x, y, w, h};
        this.pixelRatio = pixelRatio;
    }

    get tl(): [number, number] {
        return [
            this.paddedRect.x + padding,
            this.paddedRect.y + padding
        ];
    }

    get br(): [number, number] {
        return [
            this.paddedRect.x + this.paddedRect.w - padding,
            this.paddedRect.y + this.paddedRect.h - padding
        ];
    }

    get displaySize(): [number, number] {
        return [
            (this.paddedRect.w - padding * 2) / this.pixelRatio,
            (this.paddedRect.h - padding * 2) / this.pixelRatio
        ];
    }
}

export default class ImageAtlas {
    image: RGBAImage;
    iconPositions: {[string]: ImagePosition};
    patternPositions: {[string]: ImagePosition};
    uploaded: ?boolean;

    constructor(icons: {[string]: StyleImage}, patterns: {[string]: StyleImage}) {
        const image = new RGBAImage({width: 0, height: 0});
        const iconPositions = {}, patternPositions = {};

        const pack = new ShelfPack(0, 0, {autoResize: true});

        for (const id in icons) {
            const icon = icons[id];
            const bin = this._packSprite(pack, icon, image, false);
            iconPositions[id] = new ImagePosition(bin, icon);
        }

        for (const id in patterns) {
            const pattern = patterns[id];
            const bin = this._packSprite(pack, pattern, image, true);
            patternPositions[id] = new ImagePosition(bin, pattern);
        }

        pack.shrink();
        image.resize({
            width: pack.w,
            height: pack.h
        });

        this.image = image;
        this.iconPositions = iconPositions;
        this.patternPositions = patternPositions;
    }

    _packSprite(pack: ShelfPack, sprite: StyleImage, image: RGBAImage, pattern: boolean) {
        const bin = pack.packOne(
            sprite.data.width + 2 * padding,
            sprite.data.height + 2 * padding);

        image.resize({
            width: pack.w,
            height: pack.h
        });

        const x = bin.x + padding,
            y = bin.y + padding,
            w = sprite.data.width,
            h = sprite.data.height;

        RGBAImage.copy(sprite.data, image, { x: 0, y: 0 }, { x, y }, { width: w, height: h });
        if (pattern) {
            // Add 1 pixel wrapped padding on each side of the pattern.
            RGBAImage.copy(sprite.data, image, { x: 0, y: h - 1 }, { x: x, y: y - 1 }, { width: w, height: 1 }); // T
            RGBAImage.copy(sprite.data, image, { x: 0, y:     0 }, { x: x, y: y + h }, { width: w, height: 1 }); // B
            RGBAImage.copy(sprite.data, image, { x: w - 1, y: 0 }, { x: x - 1, y: y }, { width: 1, height: h }); // L
            RGBAImage.copy(sprite.data, image, { x: 0,     y: 0 }, { x: x + w, y: y }, { width: 1, height: h }); // R
        }
        return bin;
    }
}

register('ImagePosition', ImagePosition);
register('ImageAtlas', ImageAtlas);

