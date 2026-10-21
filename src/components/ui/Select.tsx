import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type AriaAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown } from './icons';
import styles from './Select.module.scss';

export interface SelectOption {
  value: string;
  label: string;
  /**
   * 第二行说明，例如一条出口的地址。
   *
   * 有些选项光看名字分不清（几条同名的出口、几条只有编号的地址），把它们挤在
   * 一行里只能靠截断，谁也认不出谁。第二行让「这是什么」和「它长什么样」各占一行。
   */
  description?: string;
}

interface SelectProps {
  value: string;
  options: ReadonlyArray<SelectOption>;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  ariaInvalid?: AriaAttributes['aria-invalid'];
  fullWidth?: boolean;
  size?: 'sm' | 'md';
  id?: string;
}

const VIEWPORT_MARGIN = 8;
const DROPDOWN_OFFSET = 6;
const DROPDOWN_MAX_HEIGHT = 240;
/**
 * 下拉最大宽度。窄触发器上的下拉如果只跟着触发器宽，选项就会折成「直／连」这种
 * 两字一行的样子；宽度跟内容走、再用这个上限收住，长标签才不至于横到屏幕外面。
 */
const DROPDOWN_MAX_WIDTH = 420;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const resolveDropdownStyle = (element: HTMLElement): CSSProperties => {
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  // 触发器的宽度只是下限：真正宽度由内容决定（见 DROPDOWN_MAX_WIDTH）。
  const available = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const minWidth = Math.min(rect.width, available);
  const left = clamp(
    rect.left,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportWidth - minWidth - VIEWPORT_MARGIN)
  );
  const maxWidth = Math.min(
    Math.max(minWidth, DROPDOWN_MAX_WIDTH),
    Math.max(0, viewportWidth - left - VIEWPORT_MARGIN)
  );
  const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN - DROPDOWN_OFFSET;
  const spaceAbove = rect.top - VIEWPORT_MARGIN - DROPDOWN_OFFSET;
  const direction = spaceBelow >= DROPDOWN_MAX_HEIGHT || spaceBelow >= spaceAbove ? 'down' : 'up';
  const maxHeight = Math.max(
    0,
    Math.min(DROPDOWN_MAX_HEIGHT, direction === 'down' ? spaceBelow : spaceAbove)
  );

  return direction === 'down'
    ? {
        position: 'fixed',
        top: rect.bottom + DROPDOWN_OFFSET,
        left,
        minWidth,
        maxWidth,
        maxHeight,
      }
    : {
        position: 'fixed',
        bottom: viewportHeight - rect.top + DROPDOWN_OFFSET,
        left,
        minWidth,
        maxWidth,
        maxHeight,
      };
};

export function Select({
  value,
  options,
  onChange,
  placeholder,
  className,
  disabled = false,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  ariaInvalid,
  fullWidth = true,
  size = 'md',
  id,
}: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const listboxId = `${selectId}-listbox`;
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [indicator, setIndicator] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const isOpen = open && !disabled;

  useEffect(() => {
    if (!open || disabled) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [disabled, open]);

  const updateDropdownStyle = useCallback(() => {
    if (!wrapRef.current) return;
    setDropdownStyle(resolveDropdownStyle(wrapRef.current));
  }, []);

  const scheduleDropdownStyleUpdate = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      updateDropdownStyle();
    });
  }, [updateDropdownStyle]);

  useLayoutEffect(() => {
    if (!isOpen) {
      if (rafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    updateDropdownStyle();

    const handleViewportChange = () => {
      scheduleDropdownStyleUpdate();
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && wrapRef.current
        ? new ResizeObserver(() => {
            scheduleDropdownStyleUpdate();
          })
        : null;

    if (resizeObserver && wrapRef.current) {
      resizeObserver.observe(wrapRef.current);
    }

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      resizeObserver?.disconnect();
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isOpen, scheduleDropdownStyleUpdate, updateDropdownStyle]);

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value]
  );
  const resolvedHighlightedIndex =
    highlightedIndex >= 0
      ? highlightedIndex
      : selectedIndex >= 0
        ? selectedIndex
        : options.length > 0
          ? 0
          : -1;
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const displayText = selected?.label ?? placeholder ?? '';
  const isPlaceholder = !selected && placeholder;

  const commitSelection = useCallback(
    (nextIndex: number) => {
      const nextOption = options[nextIndex];
      if (!nextOption) return;
      onChange(nextOption.value);
      setOpen(false);
      setHighlightedIndex(nextIndex);
      triggerRef.current?.focus({ preventScroll: true });
    },
    [onChange, options]
  );

  const moveHighlight = useCallback(
    (direction: 1 | -1) => {
      if (options.length === 0) return;
      const nextIndex = (resolvedHighlightedIndex + direction + options.length) % options.length;
      setHighlightedIndex(nextIndex);
    },
    [options.length, resolvedHighlightedIndex]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          if (!isOpen) {
            setOpen(true);
            return;
          }
          moveHighlight(1);
          return;
        case 'ArrowUp':
          event.preventDefault();
          if (!isOpen) {
            setOpen(true);
            return;
          }
          moveHighlight(-1);
          return;
        case 'Home':
          if (!isOpen || options.length === 0) return;
          event.preventDefault();
          setHighlightedIndex(0);
          return;
        case 'End':
          if (!isOpen || options.length === 0) return;
          event.preventDefault();
          setHighlightedIndex(options.length - 1);
          return;
        case 'Enter':
        case ' ': {
          event.preventDefault();
          if (!isOpen) {
            setOpen(true);
            return;
          }
          if (resolvedHighlightedIndex >= 0) {
            commitSelection(resolvedHighlightedIndex);
          }
          return;
        }
        case 'Escape':
          if (!isOpen) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus({ preventScroll: true });
          return;
        case 'Tab':
          if (isOpen) setOpen(false);
          return;
        default:
          return;
      }
    },
    [commitSelection, disabled, isOpen, moveHighlight, options.length, resolvedHighlightedIndex]
  );

  useEffect(() => {
    if (!isOpen || resolvedHighlightedIndex < 0) return;
    const highlightedOption = document.getElementById(
      `${selectId}-option-${resolvedHighlightedIndex}`
    );
    highlightedOption?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, resolvedHighlightedIndex, selectId]);

  // The highlight indicator is a single absolutely positioned block inside the list. Its geometry
  // comes from the highlighted option's real box, so wrapping labels and mixed row heights work.
  useLayoutEffect(() => {
    const list = dropdownRef.current;
    const option = isOpen ? optionRefs.current[resolvedHighlightedIndex] : null;
    if (!list || !option) {
      setIndicator(null);
      return;
    }
    const listRect = list.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    setIndicator({
      top: optionRect.top - listRect.top - list.clientTop + list.scrollTop,
      left: optionRect.left - listRect.left - list.clientLeft + list.scrollLeft,
      width: optionRect.width,
      height: optionRect.height,
    });
  }, [dropdownStyle, isOpen, options, resolvedHighlightedIndex]);

  const dropdown =
    isOpen && dropdownStyle ? (
      <div
        ref={dropdownRef}
        className={styles.dropdown}
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        style={dropdownStyle}
      >
        {indicator ? (
          <span
            className={styles.indicator}
            aria-hidden="true"
            style={{
              top: indicator.top,
              left: indicator.left,
              width: indicator.width,
              height: indicator.height,
            }}
          />
        ) : null}
        {options.map((opt, index) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              id={`${selectId}-option-${index}`}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              role="option"
              aria-selected={active}
              className={`${styles.option} ${active ? styles.optionSelected : ''}`.trim()}
              onMouseEnter={() => setHighlightedIndex(index)}
              onKeyDown={handleKeyDown}
              onClick={() => commitSelection(index)}
            >
              <span className={styles.optionLabel}>
                <span className={styles.optionTitle}>{opt.label}</span>
                {opt.description ? (
                  <span className={styles.optionDescription} title={opt.description}>
                    {opt.description}
                  </span>
                ) : null}
              </span>
              {active ? (
                <span className={styles.optionCheck} aria-hidden="true">
                  <IconCheck size={14} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <>
      <div
        className={`${styles.wrap} ${fullWidth ? styles.wrapFullWidth : ''} ${className ?? ''}`}
        ref={wrapRef}
      >
        <button
          id={selectId}
          ref={triggerRef}
          type="button"
          className={`${styles.trigger} ${size === 'sm' ? styles.triggerSm : ''}`.trim()}
          onClick={disabled ? undefined : () => setOpen((prev) => !prev)}
          onKeyDown={handleKeyDown}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listboxId : undefined}
          aria-activedescendant={
            isOpen && resolvedHighlightedIndex >= 0
              ? `${selectId}-option-${resolvedHighlightedIndex}`
              : undefined
          }
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          disabled={disabled}
        >
          <span className={`${styles.triggerText} ${isPlaceholder ? styles.placeholder : ''}`}>
            {displayText}
          </span>
          <span className={styles.triggerIcon} aria-hidden="true">
            <IconChevronDown size={14} />
          </span>
        </button>
      </div>
      {dropdown &&
        (typeof document === 'undefined' ? dropdown : createPortal(dropdown, document.body))}
    </>
  );
}
