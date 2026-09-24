import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type TextareaHTMLAttributes,
} from "react";
import { BookOpen, X } from "lucide-react";
import "./skills.css";

export type SkillChoice = { id: string; name: string; description?: string };
export function SkillSelection({
  skills,
  value,
  onChange,
  disabled = false,
}: {
  skills: SkillChoice[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="skill-selection" disabled={disabled}>
      <legend>搭配技能</legend>
      {!skills.length && (
        <p className="muted">暂无可用技能，请先到技能目录创建或安装。</p>
      )}
      {skills.map((skill) => (
        <label key={skill.id}>
          <input
            type="checkbox"
            checked={value.includes(skill.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, skill.id]
                  : value.filter((id) => id !== skill.id),
              )
            }
          />
          <span>
            {skill.name}
            <small>{skill.description}</small>
          </span>
        </label>
      ))}
      {value
        .filter((id) => !skills.some((s) => s.id === id))
        .map((id) => (
          <label key={id}>
            <input
              type="checkbox"
              checked
              onChange={() => onChange(value.filter((s) => s !== id))}
            />
            <span>
              不可用的技能：{id}
              <small>请移除后重新选择</small>
            </span>
          </label>
        ))}
    </fieldset>
  );
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
  value: string;
  skills: SkillChoice[];
  selectedIds: string[];
  onSkillsChange: (ids: string[]) => void;
  onValueChange: (value: string) => void;
  skillsDisabled?: boolean;
};
export const SkillComposerInput = forwardRef<HTMLTextAreaElement, Props>(
  function SkillComposerInput(
    {
      skills,
      selectedIds,
      onSkillsChange,
      onValueChange,
      skillsDisabled = false,
      value,
      onChange,
      onKeyDown,
      onSelect,
      ...props
    },
    forwardedRef,
  ) {
    const localRef = useRef<HTMLTextAreaElement | null>(null);
    const listId = useId();
    const [query, setQuery] = useState<{
      start: number;
      end: number;
      text: string;
    } | null>(null);
    const [active, setActive] = useState(0);
    const menuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      menuRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    }, [active]);
    function track(input: HTMLTextAreaElement) {
      const end = input.selectionStart;
      const match = /(?:^|\s)\/([^\s/]*)$/.exec(input.value.slice(0, end));
      setQuery(
        !skillsDisabled && match
          ? { start: end - match[1]!.length - 1, end, text: match[1]! }
          : null,
      );
      setActive(0);
    }
    const matches = query
      ? skills
          .filter(
            (s) =>
              !selectedIds.includes(s.id) &&
              `${s.name} ${s.description || ""} ${s.id}`
                .toLowerCase()
                .includes(query.text.toLowerCase()),
          )
          .slice(0, 12)
      : [];
    const choose = (skill: SkillChoice) => {
      if (!query || selectedIds.length >= 20) return;
      onSkillsChange([...selectedIds, skill.id]);
      onValueChange(value.slice(0, query.start) + value.slice(query.end));
      setQuery(null);
      requestAnimationFrame(() => {
        localRef.current?.focus();
        localRef.current?.setSelectionRange(query.start, query.start);
      });
    };
    return (
      <div className="skill-composer-input">
        {selectedIds.length > 0 && (
          <div className="skill-chips" aria-label="已选技能">
            {selectedIds.map((id) => (
              <span key={id}>
                <BookOpen size={13} />
                {skills.find((s) => s.id === id)?.name || id}
                <button
                  type="button"
                  disabled={props.disabled || skillsDisabled}
                  aria-label={`移除技能 ${skills.find((s) => s.id === id)?.name || id}`}
                  onClick={() =>
                    onSkillsChange(selectedIds.filter((s) => s !== id))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {query && (
          <div className="skill-slash-menu">
            <div className="skill-slash-heading">
              选择技能 <small>↑ ↓ 选择 · Enter 加载 · Esc 关闭</small>
            </div>
            <div ref={menuRef} id={listId} role="listbox" aria-label="选择技能">
              {selectedIds.length >= 20 ? (
                <p role="status">每次最多选择 20 个技能，请先移除一项。</p>
              ) : matches.length ? (
                matches.map((skill, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active === index}
                    id={`${listId}-${index}`}
                    key={skill.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(skill)}
                  >
                    <BookOpen size={16} />
                    <span>
                      {skill.name}
                      <small>{skill.description}</small>
                    </span>
                  </button>
                ))
              ) : (
                <p role="status">没有匹配的技能，试试中文名称或其他关键词。</p>
              )}
            </div>
          </div>
        )}
        <textarea
          {...props}
          onBlur={(e) => {
            setQuery(null);
            props.onBlur?.(e);
          }}
          value={value}
          ref={(node) => {
            localRef.current = node;
            if (typeof forwardedRef === "function") forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          aria-autocomplete="list"
          aria-controls={query ? listId : undefined}
          aria-expanded={!!query}
          aria-activedescendant={
            query && matches.length ? `${listId}-${active}` : undefined
          }
          onChange={(e) => {
            onValueChange(e.target.value);
            onChange?.(e);
            track(e.target);
          }}
          onSelect={(e) => {
            track(e.currentTarget);
            onSelect?.(e);
          }}
          onKeyDown={(e) => {
            if (query && !e.nativeEvent.isComposing) {
              if (e.key === "Escape") {
                e.preventDefault();
                setQuery(null);
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) =>
                  matches.length
                    ? (i + (e.key === "ArrowDown" ? 1 : -1) + matches.length) %
                      matches.length
                    : 0,
                );
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (matches[active]) choose(matches[active]);
                return;
              }
            }
            onKeyDown?.(e);
          }}
        />
      </div>
    );
  },
);
