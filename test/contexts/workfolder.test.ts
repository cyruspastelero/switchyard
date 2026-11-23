import { describe, it, expect } from '../support/harness.ts';
import { pathsFromToolInput, pickWorkFolder } from '../../src/contexts/workfolder.ts';

describe('pathsFromToolInput', () => {
  it('file_tools_give_their_absolute_path', () => {
    expect(pathsFromToolInput('{"file_path":"/work/tala/src/a.ts"}')).toEqual(['/work/tala/src/a.ts']);
    expect(pathsFromToolInput('{"notebook_path":"/work/tala/n.ipynb"}')).toEqual(['/work/tala/n.ipynb']);
    expect(pathsFromToolInput('{"path":"/work/tala","pattern":"x"}')).toEqual(['/work/tala']);
  });
  it('a_shell_command_gives_the_folder_it_changes_into', () => {
    expect(pathsFromToolInput('{"command":"cd /work/tala && npm test"}')).toEqual(['/work/tala']);
    expect(pathsFromToolInput('{"command":"cd \\"/work/my app\\" && ls"}')).toEqual(['/work/my app']);
    expect(pathsFromToolInput('{"command":"git status"}')).toEqual([]);
  });
  it('relative_paths_and_unreadable_input_give_nothing', () => {
    expect(pathsFromToolInput('{"file_path":"src/a.ts"}')).toEqual([]);
    expect(pathsFromToolInput('{"command":"cd src && ls"}')).toEqual([]);
    expect(pathsFromToolInput('not json')).toEqual([]);
    expect(pathsFromToolInput(null)).toEqual([]);
  });
});

describe('pickWorkFolder', () => {
  const times = (root: string, n: number): string[] => Array.from({ length: n }, () => root);

  it('a_session_started_in_the_parent_but_working_in_one_child_belongs_to_the_child', () => {
    expect(pickWorkFolder('/work', [...times('/work/tala', 8), ...times('/work', 2)])).toBe('/work/tala');
  });
  it('work_spread_over_several_children_stays_with_the_parent', () => {
    expect(pickWorkFolder('/work', [...times('/work/tala', 5), ...times('/work/arki', 5)])).toBe('/work');
  });
  it('a_handful_of_touches_is_not_enough_to_move', () => {
    expect(pickWorkFolder('/work', times('/work/tala', 3))).toBe('/work');
  });
  it('folders_outside_the_session_folder_are_ignored', () => {
    expect(pickWorkFolder('/work', [...times('/tmp/scratch', 30), ...times('/work/tala', 6)])).toBe('/work/tala');
    expect(pickWorkFolder('/work/tala', times('/work/arki', 30))).toBe('/work/tala');
  });
  it('no_activity_keeps_the_session_folder', () => {
    expect(pickWorkFolder('/work', [])).toBe('/work');
  });
});
