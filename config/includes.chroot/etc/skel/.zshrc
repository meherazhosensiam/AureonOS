setopt PROMPT_SUBST

PROMPT=$'╭─󰣇 AUREON %F{81}%n@%m%f %F{214}%~%f $(git_prompt_info)
╰─➜ '

# ==============================
# AUREON OS - Futuristic .zshrc
# ==============================

export EDITOR=nano
export PAGER=less
export HISTSIZE=100000
export SAVEHIST=100000
export HISTFILE=$HOME/.zsh_history

setopt AUTO_CD AUTO_PUSHD EXTENDED_HISTORY HIST_IGNORE_DUPS \
       SHARE_HISTORY APPEND_HISTORY INTERACTIVE_COMMENTS

autoload -Uz colors && colors
autoload -Uz compinit && compinit

PROMPT='%F{196}
╭─󰣇 AUREON %F{196}%n@%m%f %F{214}%~%f $(git_prompt_info)
╰─%F{196}➜%f '

RPROMPT='%F{244}%D{%H:%M:%S}%f'

git_prompt_info() {
  command git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return
  local b=$(git branch --show-current 2>/dev/null)
  printf "%%F{220}[ %s]%%f" "$b"
}

preexec() { TIMER=$EPOCHSECONDS; }
precmd() {
  if [[ -n "$TIMER" ]]; then
    local t=$((EPOCHSECONDS-TIMER))
    RPROMPT="%F{244}${t}s | %D{%H:%M:%S}%f"
  fi
}

alias ll='ls -alF --color=auto'
alias la='ls -A --color=auto'
alias l='ls -CF --color=auto'
alias grep='grep --color=auto'
alias cls='clear'
alias ..='cd ..'
alias ...='cd ../..'
alias update='sudo apt update && sudo apt full-upgrade -y'
alias ports='ss -tulpn'
alias myip='hostname -I'
alias dfh='df -h'
alias duh='du -sh ./*'

if command -v fastfetch >/dev/null 2>&1; then
  fastfetch
elif command -v neofetch >/dev/null 2>&1; then
  neofetch
fi

[[ -f /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]] && \
 source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh

[[ -f /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]] && \
 source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=242'
alias ls='ls --color=auto'
alias ll='ls -lah --color=auto'
alias la='ls -A --color=auto'
export LS_COLORS='di=1;31:ln=1;36:so=1;35:pi=33:ex=1;32:bd=1;33:cd=1;33:su=37;41:sg=30;43:tw=30;42:ow=1;31:*.jpg=1;35:*.png=1;35:*.gif=1;35:*.mp4=1;31:*.zip=1;91:*.tar=1;91:*.pdf=1;31:*.sh=1;32'

# Syntax highlighting
source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# Command autosuggestions
source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh


# AureonOS Root Prompt
if [[ $EUID -eq 0 ]]; then
    PROMPT='%F{196}
╭─󰣇 ROOT %F{196}%n@%m%f %F{214}%~%f
╰─%F{196}#%f '
fi
export LS_COLORS='di=01;31:fi=01;37:ln=01;36:ex=01;32:*.sh=01;32:*.png=01;35:*.jpg=01;35:*.pdf=01;31:*.zip=01;91'

# Syntax highlighting
source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# Command autosuggestions
source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh

# opencode
export PATH=/home/siam/.opencode/bin:$PATH
