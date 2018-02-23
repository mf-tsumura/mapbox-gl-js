// @flow
import { createLayout } from '../../util/struct_array';

export const lineLayoutAttributes = createLayout([
    {name: 'a_pos_normal', components: 4, type: 'Int16'},
    {name: 'a_data', components: 4, type: 'Uint8'}
], 4);

// these attributes are only needed if using data-driven line-pattern
export const linePatternSourceExpressionLayout = createLayout([
    // [tl.x, tl.y, br.x, br.y]
    {name: 'a_pattern_a',  components: 2, type: 'Float32'},
    {name: 'a_pattern_b',  components: 2, type: 'Float32'}
]);

export const linePatternCompositeExpressionLayout = createLayout([
    // [tl.x, tl.y, br.x, br.y]
    {name: 'a_pattern_a',  components: 4, type: 'Float32'},
    {name: 'a_pattern_b',  components: 4, type: 'Float32'}
]);


export default lineLayoutAttributes;
export const {members, size, alignment} = lineLayoutAttributes;
