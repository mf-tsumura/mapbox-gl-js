// @flow

import { packUint8ToFloat } from '../shaders/encode_attribute';
import Color from '../style-spec/util/color';
import { supportsPropertyExpression } from '../style-spec/util/properties';
import { register } from '../util/web_worker_transfer';
import { PossiblyEvaluatedPropertyValue } from '../style/properties';
import { StructArrayLayout1f4, StructArrayLayout2f8, StructArrayLayout4f16, PatternLayoutArray } from './array_types';
import browser from '../util/browser';

import type Tile from '../source/tile';
import EvaluationParameters from '../style/evaluation_parameters';
import type Context from '../gl/context';
import type {TypedStyleLayer} from '../style/style_layer/typed_style_layer';
import type { CrossfadeParameters } from '../style/style_layer';
import type {StructArray, StructArrayMember} from '../util/struct_array';
import type VertexBuffer from '../gl/vertex_buffer';
import type Program from '../render/program';
import type {ImagePosition} from '../render/image_atlas';
import type {
    Feature,
    FeatureState,
    GlobalProperties,
    SourceExpression,
    CompositeExpression
} from '../style-spec/expression';
import type {PossiblyEvaluated} from '../style/properties';
import type {FeatureStates} from '../source/source_state';
import pixelsToTileUnits from '../source/pixels_to_tile_units';

type FeaturePaintBufferMap = {
    [feature_id: string]: Array<{
        index: number,
        start: number,
        end: number
    }>
};

function packColor(color: Color): [number, number] {
    return [
        packUint8ToFloat(255 * color.r, 255 * color.g),
        packUint8ToFloat(255 * color.b, 255 * color.a)
    ];
}

/**
 *  `Binder` is the interface definition for the strategies for constructing,
 *  uploading, and binding paint property data as GLSL attributes. Most style-
 *  spec properties have a 1:1 relationship to shader attribute/uniforms, but
 *  some require multliple values per feature to be passed to the GPU, and in
 *  those cases we bind multiple attributes/uniforms.
 *
 *  It has three implementations, one for each of the three strategies we use:
 *
 *  * For _constant_ properties -- those whose value is a constant, or the constant
 *    result of evaluating a camera expression at a particular camera position -- we
 *    don't need a vertex attribute buffer, and instead use a uniform.
 *  * For data expressions, we use a vertex buffer with a single attribute value,
 *    the evaluated result of the source function for the given feature.
 *  * For composite expressions, we use a vertex buffer with two attributes: min and
 *    max values covering the range of zooms at which we expect the tile to be
 *    displayed. These values are calculated by evaluating the composite expression for
 *    the given feature at strategically chosen zoom levels. In addition to this
 *    attribute data, we also use a uniform value which the shader uses to interpolate
 *    between the min and max value at the final displayed zoom level. The use of a
 *    uniform allows us to cheaply update the value on every frame.
 *
 *  Note that the shader source varies depending on whether we're using a uniform or
 *  attribute. We dynamically compile shaders at runtime to accomodate this.
 *
 * @private
 */
interface Binder<T> {
    statistics: { max: number };
    paintVertexArray?: StructArray;

    populatePaintArray(length: number, feature: Feature, imagePositions: {[string]: ImagePosition}): void;
    updatePaintArray(start: number, length: number, feature: Feature, featureState: FeatureState, imagePositions: {[string]: ImagePosition}): void;
    upload(Context): void;
    destroy(): void;

    defines(): Array<string>;

    setUniforms(context: Context,
                program: Program,
                globals: GlobalProperties,
                currentValue: PossiblyEvaluatedPropertyValue<T>): void;

    setTileSpecificUniforms(context: Context,
                program: Program,
                globals: GlobalProperties,
                currentValue: PossiblyEvaluatedPropertyValue<T>,
                tileZoom: number,
                tile: Tile,
                crossfade: ?CrossfadeParameters): void;
}

class ConstantBinder<T> implements Binder<T> {
    value: T;
    names: Array<string>;
    type: string;
    statistics: { max: number };

    constructor(value: T, names: Array<string>, type: string) {
        this.value = value;
        this.names = names;
        this.type = type;
        this.statistics = { max: -Infinity };
    }

    defines() {
        return this.names.map(name => `#define HAS_UNIFORM_u_${name}`);
    }

    populatePaintArray() {}
    updatePaintArray() {}
    upload() {}
    destroy() {}
    setTileSpecificUniforms() {}

    setUniforms(context: Context,
                program: Program,
                globals: GlobalProperties,
                currentValue: PossiblyEvaluatedPropertyValue<T>) {
        const value: any = currentValue.constantOr(this.value);
        const gl = context.gl;
        for (let i = 0; i < this.names.length; i++) {
            const name = this.names[i];
            if (this.type === 'color') {
                gl.uniform4f(program.uniforms[`u_${name}`], value.r, value.g, value.b, value.a);
            } else {
                gl.uniform1f(program.uniforms[`u_${name}`], value);
            }
        }
    }
}

class CrossFadedConstantBinder<T> implements Binder<T> {
    value: T;
    names: Array<string>;
    type: string;
    statistics: { max: number };

    constructor(value: T, names: Array<string>, type: string) {
        this.value = value;
        this.names = names;
        this.type = type;
        this.statistics = { max: -Infinity };
    }

    defines() {
        return this.names.map(name => `#define HAS_UNIFORM_u_${name}`);
    }

    populatePaintArray() {}
    updatePaintArray() {}
    upload() {}
    destroy() {}

    setTileSpecificUniforms(context: Context,
                            program: Program,
                            globals: GlobalProperties,
                            currentValue: PossiblyEvaluatedPropertyValue<T>,
                            tileZoom: number,
                            tile: Tile) {
        const image: any = currentValue.constantOr(this.value);
        const gl = context.gl;

        if (image && tile && tile.iconAtlas) {
            const imagePosFrom = tile.iconAtlas.positions[image.from],
                imagePosTo = tile.iconAtlas.positions[image.to];
            if (!imagePosFrom || !imagePosTo) return;

            gl.uniform4fv(program.uniforms.u_pattern_from, (imagePosFrom: any).tl.concat((imagePosFrom: any).br));
            gl.uniform4fv(program.uniforms.u_pattern_to, (imagePosTo: any).tl.concat((imagePosTo: any).br));

            const tileRatio = 1 / pixelsToTileUnits(tile, 1, tileZoom);
            // this assumes all images in the icon atlas texture have the same pixel ratio
            gl.uniform4f(program.uniforms.u_scale, imagePosTo.pixelRatio, tileRatio, image.fromScale, image.toScale);

            const numTiles = Math.pow(2, tile.tileID.overscaledZ);
            const tileSizeAtNearestZoom = tile.tileSize * Math.pow(2, tileZoom) / numTiles;
            const pixelX = tileSizeAtNearestZoom * (tile.tileID.canonical.x + tile.tileID.wrap * numTiles);
            const pixelY = tileSizeAtNearestZoom * tile.tileID.canonical.y;
            // split the pixel coord into two pairs of 16 bit numbers. The glsl spec only guarantees 16 bits of precision.
            gl.uniform2f(program.uniforms.u_pixel_coord_upper, pixelX >> 16, pixelY >> 16);
            gl.uniform2f(program.uniforms.u_pixel_coord_lower, pixelX & 0xFFFF, pixelY & 0xFFFF);


            gl.uniform1f(program.uniforms.u_fade, image.t);
            gl.uniform1i(program.uniforms.u_image, 0);
            context.activeTexture.set(gl.TEXTURE0);
            tile.iconAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            gl.uniform2fv(program.uniforms.u_texsize, tile.iconAtlasTexture.size);
        }
    }

    setUniforms() {}
}

class SourceExpressionBinder<T> implements Binder<T> {
    expression: SourceExpression;
    names: Array<string>;
    type: string;
    statistics: { max: number };

    paintVertexArray: StructArray;
    paintVertexAttributes: Array<StructArrayMember>;
    paintVertexBuffer: ?VertexBuffer;

    constructor(expression: SourceExpression, names: Array<string>, type: string, PaintVertexArray: Class<StructArray>) {
        this.expression = expression;
        this.names = names;
        this.type = type;
        this.statistics = { max: -Infinity };
        this.paintVertexAttributes = names.map((name) =>
            ({
                name: `a_${name}`,
                type: 'Float32',
                components: type === 'color' ? 2 : 1,
                offset: 0
            })
        );
        this.paintVertexArray = new PaintVertexArray();
    }

    defines() {
        return [];
    }

    populatePaintArray(newLength: number, feature: Feature) {
        const paintArray = this.paintVertexArray;

        const start = paintArray.length;
        paintArray.reserve(newLength);

        const value = this.expression.evaluate(new EvaluationParameters(0), feature);

        if (this.type === 'color') {
            const color = packColor(value);
            for (let i = start; i < newLength; i++) {
                paintArray.emplaceBack(color[0], color[1]);
            }
        } else {
            for (let i = start; i < newLength; i++) {
                paintArray.emplaceBack(value);
            }

            this.statistics.max = Math.max(this.statistics.max, value);
        }
    }

    updatePaintArray(start: number, end: number, feature: Feature, featureState: FeatureState) {
        const paintArray = this.paintVertexArray;
        const value = this.expression.evaluate({zoom: 0}, feature, featureState);

        if (this.type === 'color') {
            const color = packColor(value);
            for (let i = start; i < end; i++) {
                paintArray.emplace(i, color[0], color[1]);
            }
        } else {
            for (let i = start; i < end; i++) {
                paintArray.emplace(i, value);
            }

            this.statistics.max = Math.max(this.statistics.max, value);
        }
    }

    upload(context: Context) {
        if (this.paintVertexArray) {
            this.paintVertexBuffer = context.createVertexBuffer(this.paintVertexArray, this.paintVertexAttributes, this.expression.isStateDependent);
        }
    }

    destroy() {
        if (this.paintVertexBuffer) {
            this.paintVertexBuffer.destroy();
        }
    }

    setUniforms(context: Context, program: Program) {
        context.gl.uniform1f(program.uniforms[`a_${this.names[0]}_t`], 0);
    }

    setTileSpecificUniforms() {}
}

class CompositeExpressionBinder<T> implements Binder<T> {
    expression: CompositeExpression;
    names: Array<string>;
    type: string;
    useIntegerZoom: boolean;
    zoom: number;
    statistics: { max: number };

    paintVertexArray: StructArray;
    paintVertexAttributes: Array<StructArrayMember>;
    paintVertexBuffer: ?VertexBuffer;

    constructor(expression: CompositeExpression, names: Array<string>, type: string, useIntegerZoom: boolean, zoom: number, layout: Class<StructArray>) {
        this.expression = expression;
        this.names = names;
        this.type = type;
        this.useIntegerZoom = useIntegerZoom;
        this.zoom = zoom;
        this.statistics = { max: -Infinity };
        const PaintVertexArray = layout;
        this.paintVertexAttributes = names.map((name) => {
            return {
                name: `a_${name}`,
                type: 'Float32',
                components: type === 'color' ? 4 : 2,
                offset: 0
            };
        });
        this.paintVertexArray = new PaintVertexArray();
    }

    defines() {
        return [];
    }

    populatePaintArray(newLength: number, feature: Feature) {
        const paintArray = this.paintVertexArray;

        const start = paintArray.length;
        paintArray.reserve(newLength);

        const min = this.expression.evaluate(new EvaluationParameters(this.zoom), feature);
        const max = this.expression.evaluate(new EvaluationParameters(this.zoom + 1), feature);

        if (this.type === 'color') {
            const minColor = packColor(min);
            const maxColor = packColor(max);
            for (let i = start; i < newLength; i++) {
                paintArray.emplaceBack(minColor[0], minColor[1], maxColor[0], maxColor[1]);
            }
        } else {
            for (let i = start; i < newLength; i++) {
                paintArray.emplaceBack(min, max);
            }

            this.statistics.max = Math.max(this.statistics.max, min, max);
        }
    }

    updatePaintArray(start: number, end: number, feature: Feature, featureState: FeatureState) {
        const paintArray = this.paintVertexArray;

        const min = this.expression.evaluate({zoom: this.zoom    }, feature, featureState);
        const max = this.expression.evaluate({zoom: this.zoom + 1}, feature, featureState);

        if (this.type === 'color') {
            const minColor = packColor(min);
            const maxColor = packColor(max);
            for (let i = start; i < end; i++) {
                paintArray.emplace(i, minColor[0], minColor[1], maxColor[0], maxColor[1]);
            }
        } else {
            for (let i = start; i < end; i++) {
                paintArray.emplace(i, min, max);
            }

            this.statistics.max = Math.max(this.statistics.max, min, max);
        }
    }

    upload(context: Context) {
        if (this.paintVertexArray) {
            this.paintVertexBuffer = context.createVertexBuffer(this.paintVertexArray, this.paintVertexAttributes, this.expression.isStateDependent);
        }
    }

    destroy() {
        if (this.paintVertexBuffer) {
            this.paintVertexBuffer.destroy();
        }
    }

    interpolationFactor(currentZoom: number) {
        if (this.useIntegerZoom) {
            return this.expression.interpolationFactor(Math.floor(currentZoom), this.zoom, this.zoom + 1);
        } else {
            return this.expression.interpolationFactor(currentZoom, this.zoom, this.zoom + 1);
        }
    }

    setUniforms(context: Context, program: Program, globals: GlobalProperties) {
        context.gl.uniform1f(program.uniforms[`a_${this.names[0]}_t`], this.interpolationFactor(globals.zoom));
    }

    setTileSpecificUniforms() {}
}

class CrossFadedCompositeBinder<T> implements Binder<T> {
    expression: CompositeExpression;
    names: Array<string>;
    type: string;
    useIntegerZoom: boolean;
    zoom: number;
    statistics: { max: number };

    zoomInPaintVertexArray: StructArray;
    zoomOutPaintVertexArray: StructArray;
    zoomInPaintVertexBuffer: ?VertexBuffer;
    zoomOutPaintVertexBuffer: ?VertexBuffer;
    paintVertexAttributes: Array<StructArrayMember>;

    constructor(expression: CompositeExpression, names: Array<string>, type: string, useIntegerZoom: boolean, zoom: number, PaintVertexArray: Class<StructArray>) {

        this.expression = expression;
        this.names = names;
        this.type = type;
        this.useIntegerZoom = useIntegerZoom;
        this.zoom = zoom;
        this.statistics = { max: -Infinity };

        this.paintVertexAttributes = names.map((name) =>
            ({
                name: `a_${name}`,
                type: 'Uint16',
                components: 4,
                offset: 0
            })
        );

        this.zoomInPaintVertexArray = new PaintVertexArray();
        this.zoomOutPaintVertexArray = new PaintVertexArray();
    }

    defines() {
        return [];
    }

    populatePaintArray(length: number, feature: Feature, imagePositions: {[string]: ImagePosition}) {
        // We populate two paint arrays because, for cross-faded properties, we don't know which direction
        // we're cross-fading to at layout time. In order to keep vertex attributes to a minimum and not pass
        // unnecessary vertex data to the shaders, we determine which to upload at draw time.

        const zoomInArray = this.zoomInPaintVertexArray;
        const zoomOutArray = this.zoomOutPaintVertexArray;

        const start = zoomInArray.length;

        zoomInArray.reserve(length);
        zoomOutArray.reserve(length);

        const min = this.expression.evaluate({zoom: this.zoom - 1}, feature);
        const mid = this.expression.evaluate({zoom: this.zoom }, feature);
        const max = this.expression.evaluate({zoom: this.zoom + 1}, feature);
        if (imagePositions) {
            const imageMin = imagePositions[min];
            const imageMid = imagePositions[mid];
            const imageMax = imagePositions[max];

            if (!imageMin || !imageMid || !imageMax) return;

            for (let i = start; i < length; i++) {
                zoomInArray.emplaceBack(
                    imageMid.tl[0], imageMid.tl[1], imageMid.br[0], imageMid.br[1],
                    imageMin.tl[0], imageMin.tl[1], imageMin.br[0], imageMin.br[1]
                );

                zoomOutArray.emplaceBack(
                    imageMid.tl[0], imageMid.tl[1], imageMid.br[0], imageMid.br[1],
                    imageMax.tl[0], imageMax.tl[1], imageMax.br[0], imageMax.br[1]
                );
            }
        }
    }

    updatePaintArray(start: number, end: number, feature: Feature, featureState: FeatureState, imagePositions: {[string]: ImagePosition}) {
        // We populate two paint arrays because, for cross-faded properties, we don't know which direction
        // we're cross-fading to at layout time. In order to keep vertex attributes to a minimum and not pass
        // unnecessary vertex data to the shaders, we determine which to upload at draw time.

        const zoomInArray = this.zoomInPaintVertexArray;
        const zoomOutArray = this.zoomOutPaintVertexArray;

        const min = this.expression.evaluate({zoom: this.zoom - 1}, feature, featureState);
        const mid = this.expression.evaluate({zoom: this.zoom }, feature, featureState);
        const max = this.expression.evaluate({zoom: this.zoom + 1}, feature, featureState);

        if (imagePositions) {
            const imageMin = imagePositions[min];
            const imageMid = imagePositions[mid];
            const imageMax = imagePositions[max];

            if (!imageMin || !imageMid || !imageMax) return;
            for (let i = start; i < end; i++) {
                zoomInArray.emplace(i,
                    imageMid.tl[0], imageMid.tl[1], imageMid.br[0], imageMid.br[1],
                    imageMin.tl[0], imageMin.tl[1], imageMin.br[0], imageMin.br[1]
                );

                zoomOutArray.emplace(i,
                    imageMid.tl[0], imageMid.tl[1], imageMid.br[0], imageMid.br[1],
                    imageMax.tl[0], imageMax.tl[1], imageMax.br[0], imageMax.br[1]
                );
            }
        }
    }

    getVertexBuffer(crossfade: CrossfadeParameters) {
        if (this.zoomOutPaintVertexBuffer && this.zoomInPaintVertexBuffer) {
            return crossfade.fromScale === 2 ? this.zoomInPaintVertexBuffer : this.zoomOutPaintVertexBuffer;
        }
    }

    upload(context: Context) {
        if (this.zoomInPaintVertexArray && this.zoomOutPaintVertexArray) {
            this.zoomInPaintVertexBuffer = context.createVertexBuffer(this.zoomInPaintVertexArray, this.paintVertexAttributes, this.expression.isStateDependent);
            this.zoomOutPaintVertexBuffer = context.createVertexBuffer(this.zoomOutPaintVertexArray, this.paintVertexAttributes, this.expression.isStateDependent);
        }
    }

    destroy() {
        if (this.zoomOutPaintVertexBuffer) this.zoomOutPaintVertexBuffer.destroy();
        if (this.zoomInPaintVertexBuffer) this.zoomInPaintVertexBuffer.destroy();

    }

    setTileSpecificUniforms(context: Context,
                            program: Program,
                            globals: GlobalProperties,
                            currentValue: PossiblyEvaluatedPropertyValue<T>,
                            tileZoom: number,
                            tile: Tile,
                            crossfade: ?CrossfadeParameters) {

        if (tile && crossfade) {
            const gl = context.gl;
            gl.uniform1f(program.uniforms.u_fade, crossfade.t);
            const tileRatio = 1 / pixelsToTileUnits(tile, 1, tileZoom);
            // find a better way to determine pixel ratio of tile iconAtlas images
            gl.uniform4f(program.uniforms.u_scale, browser.devicePixelRatio > 1 ? 2 : 1, tileRatio, crossfade.fromScale, crossfade.toScale);

            const numTiles = Math.pow(2, tile.tileID.overscaledZ);
            const tileSizeAtNearestZoom = tile.tileSize * Math.pow(2, tileZoom) / numTiles;
            const pixelX = tileSizeAtNearestZoom * (tile.tileID.canonical.x + tile.tileID.wrap * numTiles);
            const pixelY = tileSizeAtNearestZoom * tile.tileID.canonical.y;
            // split the pixel coord into two pairs of 16 bit numbers. The glsl spec only guarantees 16 bits of precision.
            gl.uniform2f(program.uniforms.u_pixel_coord_upper, pixelX >> 16, pixelY >> 16);
            gl.uniform2f(program.uniforms.u_pixel_coord_lower, pixelX & 0xFFFF, pixelY & 0xFFFF);

            gl.uniform1i(program.uniforms.u_image, 0);
            context.activeTexture.set(gl.TEXTURE0);
            tile.iconAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            gl.uniform2fv(program.uniforms.u_texsize, tile.iconAtlasTexture.size);
        }
    }

    setUniforms() {}
}

/**
 * ProgramConfiguration contains the logic for binding style layer properties and tile
 * layer feature data into GL program uniforms and vertex attributes.
 *
 * Non-data-driven property values are bound to shader uniforms. Data-driven property
 * values are bound to vertex attributes. In order to support a uniform GLSL syntax over
 * both, [Mapbox GL Shaders](https://github.com/mapbox/mapbox-gl-shaders) defines a `#pragma`
 * abstraction, which ProgramConfiguration is responsible for implementing. At runtime,
 * it examines the attributes of a particular layer, combines this with fixed knowledge
 * about how layers of the particular type are implemented, and determines which uniforms
 * and vertex attributes will be required. It can then substitute the appropriate text
 * into the shader source code, create and link a program, and bind the uniforms and
 * vertex attributes in preparation for drawing.
 *
 * When a vector tile is parsed, this same configuration information is used to
 * populate the attribute buffers needed for data-driven styling using the zoom
 * level and feature property data.
 *
 * @private
 */
export default class ProgramConfiguration {
    binders: { [string]: Binder<any> };
    cacheKey: string;
    layoutAttributes: Array<StructArrayMember>;

    _buffers: Array<VertexBuffer>;

    _idMap: FeaturePaintBufferMap;
    _bufferOffset: number;

    constructor() {
        this.binders = {};
        this.cacheKey = '';
        this._buffers = [];
        this._idMap = {};
        this._bufferOffset = 0;
    }

    static createDynamic<Layer: TypedStyleLayer>(layer: Layer, zoom: number, filterProperties: (string) => boolean) {
        const self = new ProgramConfiguration();
        const keys = [];

        for (const property in layer.paint._values) {
            if (!filterProperties(property)) continue;
            const value = layer.paint.get(property);
            if (!(value instanceof PossiblyEvaluatedPropertyValue) || !supportsPropertyExpression(value.property.specification)) {
                continue;
            }
            const names = paintAttributeName(property, layer.type);
            const type = value.property.specification.type;
            const useIntegerZoom = value.property.useIntegerZoom;
            if (value.property.binder === 'cross-faded') {
                if (value.value.kind === 'constant') {
                    self.binders[property] = new CrossFadedConstantBinder(value.value, names, type);
                    keys.push(`/u_${property}`);
                } else {
                    const StructArrayLayout = layoutType(property, type, 'source');
                    self.binders[property] = new CrossFadedCompositeBinder(value.value, names, type, useIntegerZoom, zoom, StructArrayLayout);
                    keys.push(`/a_${property}`);
                }
            } else if (value.value.kind === 'constant') {
                self.binders[property] = new ConstantBinder(value.value, names, type);
                keys.push(`/u_${property}`);
            } else if (value.value.kind === 'source') {
                const StructArrayLayout = layoutType(property, type, 'source');
                self.binders[property] = new SourceExpressionBinder(value.value, names, type, StructArrayLayout);
                keys.push(`/a_${property}`);
            } else {
                const StructArrayLayout = layoutType(property, type, 'composite');
                self.binders[property] = new CompositeExpressionBinder(value.value, names, type, useIntegerZoom, zoom, StructArrayLayout);
                keys.push(`/z_${property}`);
            }
        }

        self.cacheKey = keys.sort().join('');

        return self;
    }

    populatePaintArrays(newLength: number, feature: Feature, index: number, imagePositions: {[string]: ImagePosition}) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof CrossFadedCompositeBinder) {
                binder.populatePaintArray(newLength, feature, imagePositions);
            } else {
                binder.populatePaintArray(newLength, feature, {});
            }
        }
        if (feature.id) {
            const featureId = String(feature.id);
            this._idMap[featureId] = this._idMap[featureId] || [];
            this._idMap[featureId].push({
                index: index,
                start: this._bufferOffset,
                end: newLength
            });
        }

        this._bufferOffset = newLength;
    }

    updatePaintArrays(featureStates: FeatureStates, vtLayer: VectorTileLayer, layer: TypedStyleLayer, imagePositions: {[string]: ImagePosition}): boolean {
        let dirty: boolean = false;
        for (const id in featureStates) {
            const posArray = this._idMap[id];
            if (!posArray) continue;

            const featureState = featureStates[id];
            for (const pos of posArray) {
                const feature = vtLayer.feature(pos.index);

                for (const property in this.binders) {
                    const binder = this.binders[property];
                    if (binder instanceof ConstantBinder || binder instanceof CrossFadedConstantBinder) continue;
                    if ((binder: any).expression.isStateDependent === true) {
                        //AHM: Remove after https://github.com/mapbox/mapbox-gl-js/issues/6255
                        const value = layer.paint.get(property);
                        (binder: any).expression = value.value;
                        binder.updatePaintArray(pos.start, pos.end, feature, featureState, imagePositions);
                        dirty = true;
                    }
                }
            }
        }
        return dirty;
    }

    defines(): Array<string> {
        const result = [];
        for (const property in this.binders) {
            result.push.apply(result, this.binders[property].defines());
        }
        return result;
    }

    setUniforms<Properties: Object>(context: Context, program: Program, properties: PossiblyEvaluated<Properties>, globals: GlobalProperties) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            binder.setUniforms(context, program, globals, properties.get(property));
        }
    }

    setTileSpecificUniforms<Properties: Object>(context: Context, program: Program, properties: PossiblyEvaluated<Properties>, globals: GlobalProperties, tileZoom: number, tile: Tile, crossfade: CrossfadeParameters) {
        for (const property in this.binders) {
            const binder = this.binders[property];
            binder.setTileSpecificUniforms(context, program, globals, properties.get(property), tileZoom, tile, crossfade);
        }
    }

    getPaintVertexBuffers(): Array<VertexBuffer> {
        return this._buffers;
    }

    updatePatternPaintBuffers(crossfade: CrossfadeParameters) {
        const buffers = [];

        for (const property in this.binders) {
            const binder = this.binders[property];
            if (binder instanceof CrossFadedCompositeBinder) {
                const patternVertexBuffer = binder.getVertexBuffer(crossfade);
                if (patternVertexBuffer) buffers.push(patternVertexBuffer);
            } else if ((binder instanceof SourceExpressionBinder ||
                binder instanceof CompositeExpressionBinder) &&
                binder.paintVertexBuffer
            ) {
                buffers.push(binder.paintVertexBuffer);
            }
        }

        this._buffers = buffers;
    }

    upload(context: Context) {
        for (const property in this.binders) {
            this.binders[property].upload(context);
        }

        const buffers = [];
        for (const property in this.binders) {
            const binder = this.binders[property];
            if ((binder instanceof SourceExpressionBinder ||
                binder instanceof CompositeExpressionBinder) &&
                binder.paintVertexBuffer
            ) {
                buffers.push(binder.paintVertexBuffer);
            }
        }
        this._buffers = buffers;
    }

    destroy() {
        for (const property in this.binders) {
            this.binders[property].destroy();
        }
    }
}

export class ProgramConfigurationSet<Layer: TypedStyleLayer> {
    programConfigurations: {[string]: ProgramConfiguration};
    needsUpload: boolean;

    constructor(layoutAttributes: Array<StructArrayMember>, layers: $ReadOnlyArray<Layer>, zoom: number, filterProperties: (string) => boolean = () => true) {
        this.programConfigurations = {};
        for (const layer of layers) {
            this.programConfigurations[layer.id] = ProgramConfiguration.createDynamic(layer, zoom, filterProperties);
            this.programConfigurations[layer.id].layoutAttributes = layoutAttributes;
        }
        this.needsUpload = false;
    }

    populatePaintArrays(length: number, feature: Feature, index: number, imagePositions: {[string]: ImagePosition}) {
        for (const key in this.programConfigurations) {
            this.programConfigurations[key].populatePaintArrays(length, feature, index, imagePositions);
        }
        this.needsUpload = true;
    }

    updatePaintArrays(featureStates: FeatureStates, vtLayer: VectorTileLayer, layers: $ReadOnlyArray<TypedStyleLayer>, imagePositions: {[string]: ImagePosition}) {
        for (const layer of layers) {
            this.needsUpload = this.programConfigurations[layer.id].updatePaintArrays(featureStates, vtLayer, layer, imagePositions) || this.needsUpload;
        }
    }

    get(layerId: string) {
        return this.programConfigurations[layerId];
    }

    upload(context: Context) {
        if (!this.needsUpload) return;
        for (const layerId in this.programConfigurations) {
            this.programConfigurations[layerId].upload(context);
        }
        this.needsUpload = false;
    }

    destroy() {
        for (const layerId in this.programConfigurations) {
            this.programConfigurations[layerId].destroy();
        }
    }
}

function paintAttributeName(property, type) {
    const attributeNameExceptions = {
        'text-opacity': ['opacity'],
        'icon-opacity': ['opacity'],
        'text-color': ['fill_color'],
        'icon-color': ['fill_color'],
        'text-halo-color': ['halo_color'],
        'icon-halo-color': ['halo_color'],
        'text-halo-blur': ['halo_blur'],
        'icon-halo-blur': ['halo_blur'],
        'text-halo-width': ['halo_width'],
        'icon-halo-width': ['halo_width'],
        'line-gap-width': ['gapwidth'],
        'line-pattern': ['pattern_to', 'pattern_from'],
        'fill-pattern': ['pattern_to', 'pattern_from']
    };
    return attributeNameExceptions[property] ||
        [property.replace(`${type}-`, '').replace(/-/g, '_')];
}

function getLayoutException(property) {
    const propertyExceptions = {
        'line-pattern':{
            'source': PatternLayoutArray,
            'composite': PatternLayoutArray
        },
        'fill-pattern': {
            'source': PatternLayoutArray,
            'composite': PatternLayoutArray
        }
    };

    return propertyExceptions[property];
}

function layoutType(property, type, binderType) {
    const defaultLayouts = {
        'color': {
            'source': StructArrayLayout2f8,
            'composite': StructArrayLayout4f16
        },
        'number': {
            'source': StructArrayLayout1f4,
            'composite': StructArrayLayout2f8
        }
    };

    const layoutException = getLayoutException(property);
    return  layoutException && layoutException[binderType] ||
        defaultLayouts[type][binderType];
}

register('ConstantBinder', ConstantBinder);
register('CrossFadedConstantBinder', CrossFadedConstantBinder);
register('SourceExpressionBinder', SourceExpressionBinder);
register('CrossFadedCompositeBinder', CrossFadedCompositeBinder);
register('CompositeExpressionBinder', CompositeExpressionBinder);
register('ProgramConfiguration', ProgramConfiguration, {omit: ['_buffers']});
register('ProgramConfigurationSet', ProgramConfigurationSet);
