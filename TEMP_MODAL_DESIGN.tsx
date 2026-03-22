// Temporary file - Modern modal toggle design

const ToggleButton = ({ 
  isActive, 
  onClick, 
  label, 
  description, 
  color 
}: {
  isActive: boolean;
  onClick: () => void;
  label: string;
  description?: string;
  color: { bg: string; border: string; glow: string };
}) => (
  <button
    onClick={onClick}
    style={{
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      background: isActive 
        ? `linear-gradient(135deg, ${color.bg}15 0%, ${color.bg}08 100%)`
        : 'rgba(255,255,255,0.02)',
      border: `1.5px solid ${isActive ? color.border : 'rgba(255,255,255,0.06)'}`,
      borderRadius: 12,
      padding: '13px 16px',
      cursor: 'pointer',
      textAlign: 'left',
      transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
      boxShadow: isActive 
        ? `0 0 20px ${color.glow}15, 0 4px 12px rgba(0,0,0,0.15)`
        : '0 2px 4px rgba(0,0,0,0.08)',
      transform: 'scale(1)',
    }}
    onMouseEnter={e => {
      (e.currentTarget as HTMLButtonElement).style.background = isActive 
        ? `linear-gradient(135deg, ${color.bg}22 0%, ${color.bg}12 100%)`
        : 'rgba(255,255,255,0.04)';
      (e.currentTarget as HTMLButtonElement).style.borderColor = isActive ? color.glow : 'rgba(255,255,255,0.12)';
      (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.01)';
      (e.currentTarget as HTMLButtonElement).style.boxShadow = isActive 
        ? `0 0 24px ${color.glow}25, 0 6px 16px rgba(0,0,0,0.2)`
        : '0 4px 8px rgba(0,0,0,0.12)';
    }}
    onMouseLeave={e => {
      (e.currentTarget as HTMLButtonElement).style.background = isActive 
        ? `linear-gradient(135deg, ${color.bg}15 0%, ${color.bg}08 100%)`
        : 'rgba(255,255,255,0.02)';
      (e.currentTarget as HTMLButtonElement).style.borderColor = isActive ? color.border : 'rgba(255,255,255,0.06)';
      (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
      (e.currentTarget as HTMLButtonElement).style.boxShadow = isActive 
        ? `0 0 20px ${color.glow}15, 0 4px 12px rgba(0,0,0,0.15)`
        : '0 2px 4px rgba(0,0,0,0.08)';
    }}
  >
    {/* Toggle Switch */}
    <div style={{
      width: 44,
      height: 24,
      borderRadius: 12,
      background: isActive 
        ? `linear-gradient(135deg, ${color.glow} 0%, ${color.border} 100%)`
        : 'rgba(255,255,255,0.08)',
      position: 'relative',
      flexShrink: 0,
      transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
      boxShadow: isActive ? `0 0 12px ${color.glow}40, inset 0 1px 2px rgba(0,0,0,0.2)` : 'inset 0 1px 2px rgba(0,0,0,0.3)',
    }}>
      <div style={{
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: isActive ? '#fff' : 'rgba(255,255,255,0.6)',
        position: 'absolute',
        top: 3,
        left: isActive ? 23 : 3,
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        boxShadow: isActive 
          ? `0 2px 8px rgba(0,0,0,0.3), 0 0 4px ${color.glow}60`
          : '0 2px 4px rgba(0,0,0,0.2)',
      }} />
    </div>
    
    {/* Label */}
    <div style={{ flex: 1 }}>
      <div style={{ 
        fontSize: 14, 
        fontWeight: 600, 
        color: isActive ? '#fff' : 'rgba(255,255,255,0.85)',
        letterSpacing: '-0.01em',
        marginBottom: description ? 3 : 0,
      }}>
        {label}
      </div>
      {description && (
        <div style={{ 
          fontSize: 11.5, 
          color: 'rgba(255,255,255,0.4)', 
          fontWeight: 400,
        }}>
          {description}
        </div>
      )}
    </div>
    
    {/* Checkmark */}
    {isActive && (
      <svg 
        width="18" 
        height="18" 
        viewBox="0 0 24 24" 
        fill="none" 
        stroke={color.glow} 
        strokeWidth="2.5" 
        strokeLinecap="round" 
        strokeLinejoin="round"
        style={{
          flexShrink: 0,
          filter: `drop-shadow(0 0 4px ${color.glow}40)`,
        }}
      >
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    )}
  </button>
);

// Section Header
const SectionHeader = ({ title, count }: { title: string; count?: number }) => (
  <div style={{ 
    display: 'flex', 
    alignItems: 'center', 
    gap: 10,
    marginBottom: 10,
  }}>
    <div style={{ 
      fontSize: 11, 
      fontWeight: 700, 
      color: 'rgba(255,255,255,0.5)', 
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
    }}>
      {title}
    </div>
    {count !== undefined && (
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        color: 'rgba(255,255,255,0.35)',
        background: 'rgba(255,255,255,0.04)',
        padding: '2px 7px',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.06)',
      }}>
        {count}
      </div>
    )}
    <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.04)' }} />
  </div>
);
