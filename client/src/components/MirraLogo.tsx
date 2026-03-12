export function MirraLogo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: '1.1rem', md: '1.5rem', lg: '2.2rem' };
  return (
    <span style={{
      fontFamily: "'Inter', sans-serif",
      fontSize: sizes[size],
      fontWeight: 700,
      letterSpacing: '-0.03em',
      color: 'var(--mirra-text-primary)',
    }}>
      mirr<span style={{ color: 'var(--mirra-reflect)' }}>a</span>
    </span>
  );
}
