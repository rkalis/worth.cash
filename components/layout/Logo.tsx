interface Props {
  size?: number;
  className?: string;
}

// The app's mark: the whole portfolio, and one holding sitting apart from it.
//
// It grew out of the plain brand dot that used to sit here, which is why it keeps the same colour as
// revoke.cash. The open ring is everything held; the separated dot is the same asset in one of the places
// it is held, which is the idea the whole app is built around. It is also the shape the Graphs tab draws.
//
// Two solid forms and no strokes, because the same geometry is the favicon: at 16 pixels a thin outline
// disappears and a third element becomes mud, while a ring and a dot both survive.
//
// The colours are the theme tokens rather than literals, so the mark follows the brand if it ever moves.
// app/icon.svg carries the same geometry with the values inlined, since a favicon has no stylesheet.
const Logo = ({ size = 20, className }: Props) => (
  <svg viewBox="0 0 32 32" width={size} height={size} className={className} role="img" aria-label="Worth.cash">
    <path
      d="M28.99,16.45 A13.0,13.0 0 1 1 16.45,3.01 L16.20,10.40 A5.6,5.6 0 1 0 21.60,16.20 Z"
      fill="var(--color-brand)"
    />
    <circle cx="23.09" cy="9.38" r="4" fill="var(--color-brand-muted)" />
  </svg>
);

export default Logo;
