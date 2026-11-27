import sys, re

path = sys.argv[1]
choices = sys.argv[2].split(',')
text = open(path, encoding='utf-8').read()
lines = text.split('\n')

out = []
i = 0
index = 0
while i < len(lines):
    line = lines[i]
    if line.startswith('<<<<<<<'):
        ours = []
        theirs = []
        i += 1
        while i < len(lines) and not lines[i].startswith('======='):
            ours.append(lines[i]); i += 1
        i += 1
        while i < len(lines) and not lines[i].startswith('>>>>>>>'):
            theirs.append(lines[i]); i += 1
        i += 1
        choice = choices[index] if index < len(choices) else 'ours'
        index += 1
        if choice == 'ours':
            out.extend(ours)
        elif choice == 'theirs':
            out.extend(theirs)
        else:
            out.extend(ours); out.extend(theirs)
        continue
    out.append(line)
    i += 1

open(path, 'w', encoding='utf-8').write('\n'.join(out))
print(f'{path}: resolved {index} conflicts')
