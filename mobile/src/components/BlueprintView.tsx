import Svg, { Polygon, Polyline, Text as SvgText } from 'react-native-svg';
import type { PlanSheet } from '@reality/blueprint';

/**
 * The page, on screen, drawn from the same sheet the PDF is drawn from.
 *
 * Not a second implementation of the plan: `buildPlan` decided every coordinate, and both
 * this and `BlueprintPDF.swift` are transcriptions of that decision into the primitives
 * their renderer understands. If the preview and the export ever disagree it is a bug
 * here or there, never a difference of opinion about the room.
 *
 * Sheet space is SVG space already — points, origin top-left, +y down — so the viewBox is
 * the page and nothing is transformed on the way in.
 */
export function BlueprintView({ sheet, style }: { sheet: PlanSheet; style?: object }) {
  return (
    <Svg viewBox={`0 0 ${sheet.width} ${sheet.height}`} style={style}>
      {sheet.primitives.map((primitive, index) => {
        if (primitive.kind === 'path') {
          const points = primitive.points.map((p) => `${p[0]},${p[1]}`).join(' ');
          const shared = {
            points,
            fill: primitive.fill ?? 'none',
            stroke: primitive.stroke?.colour ?? 'none',
            strokeWidth: primitive.stroke?.width ?? 0,
            // `undefined` rather than an empty array: react-native-svg treats [] as a
            // dash pattern of zero length and drops the line entirely.
            strokeDasharray: primitive.stroke?.dash?.length ? primitive.stroke.dash : undefined,
            strokeLinejoin: 'round' as const,
          };
          return primitive.closed ? (
            <Polygon key={index} {...shared} />
          ) : (
            <Polyline key={index} {...shared} />
          );
        }
        return (
          <SvgText
            key={index}
            x={primitive.at[0]}
            y={primitive.at[1]}
            fontSize={primitive.sizePt}
            fontFamily="Helvetica"
            fontWeight={primitive.bold ? 'bold' : 'normal'}
            fill={primitive.colour}
            textAnchor={
              primitive.align === 'centre' ? 'middle' : primitive.align === 'right' ? 'end' : 'start'
            }
            alignmentBaseline={primitive.baseline === 'middle' ? 'middle' : 'hanging'}
            // SVG turns clockwise for a positive angle, which is the direction
            // `CGContext.rotate` turns in the flipped context the PDF renderer draws into.
            transform={
              primitive.rotationDeg
                ? `rotate(${primitive.rotationDeg} ${primitive.at[0]} ${primitive.at[1]})`
                : undefined
            }
          >
            {primitive.text}
          </SvgText>
        );
      })}
    </Svg>
  );
}
