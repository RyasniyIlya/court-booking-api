/** Білий список фонів. Має збігатися з enum BackdropStyle у schema.prisma. */
export const BACKDROP_STYLES = ['GRADIENT', 'TABLE_TENNIS', 'PADEL', 'TENNIS', 'PLAIN'] as const;
export type BackdropStyleValue = (typeof BACKDROP_STYLES)[number];
