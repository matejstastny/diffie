use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub const LOCAL_CHECKOUT: &str = "__diffie_local_checkout__";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRef {
    pub name: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub path: String,
    pub name: String,
    pub branches: Vec<BranchRef>,
    pub current_branch: Option<String>,
    pub default_base: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
    pub previous_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub base: String,
    pub head: String,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub diff: String,
    pub is_binary: bool,
    pub is_large: bool,
    pub line_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub content: String,
    pub is_binary: bool,
    pub line_count: usize,
}

pub fn open_repository(path: &str) -> Result<Repository, String> {
    let root = run(path, ["rev-parse", "--show-toplevel"])?;
    let root = root.trim().to_string();
    let branches = branches(&root)?;
    if branches.is_empty() {
        return Err("This repository has no branches yet.".into());
    }
    let current_branch = run(&root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string());
    let default_base = default_base(&root, &branches, current_branch.as_deref());
    let name = Path::new(&root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository")
        .to_string();

    Ok(Repository {
        path: root,
        name,
        branches,
        current_branch,
        default_base,
    })
}

pub fn compare(path: &str, base: &str, head: &str) -> Result<Comparison, String> {
    if base == LOCAL_CHECKOUT {
        return Err("Local checkout can only be the compare target.".into());
    }
    if base == head {
        return Ok(Comparison {
            base: base.into(),
            head: head.into(),
            files: Vec::new(),
        });
    }
    let output = if head == LOCAL_CHECKOUT {
        run_bytes(
            path,
            ["diff", "--name-status", "-z", "--find-renames", base],
        )?
    } else {
        let range = format!("{base}...{head}");
        run_bytes(
            path,
            ["diff", "--name-status", "-z", "--find-renames", &range],
        )?
    };
    Ok(Comparison {
        base: base.into(),
        head: head.into(),
        files: parse_name_status(&output),
    })
}

pub fn file_diff(path: &str, base: &str, head: &str, file_path: &str) -> Result<FileDiff, String> {
    if base == LOCAL_CHECKOUT {
        return Err("Local checkout can only be the compare target.".into());
    }
    let diff = if head == LOCAL_CHECKOUT {
        run(
            path,
            [
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--find-renames",
                "--unified=3",
                base,
                "--",
                file_path,
            ],
        )?
    } else {
        let range = format!("{base}...{head}");
        run(
            path,
            [
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--find-renames",
                "--unified=3",
                &range,
                "--",
                file_path,
            ],
        )?
    };
    let is_binary = diff.contains("Binary files ") || diff.contains("GIT binary patch");
    let line_count = diff.lines().count();
    let is_large = line_count > 12_000 || diff.len() > 1_500_000;
    Ok(FileDiff {
        path: file_path.into(),
        diff: if is_large { String::new() } else { diff },
        is_binary,
        is_large,
        line_count,
    })
}

pub fn file_contents(path: &str, revision: &str, file_path: &str) -> Result<FileContents, String> {
    let bytes = if revision == LOCAL_CHECKOUT {
        checkout_file(path, file_path)?
    } else {
        let object = format!("{revision}:{file_path}");
        run_bytes(
            path,
            [
                "show",
                "--no-ext-diff",
                "--format=",
                "--no-textconv",
                &object,
            ],
        )?
    };
    let is_binary = bytes.contains(&0);
    let content = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let line_count = content.lines().count();
    Ok(FileContents {
        content,
        is_binary,
        line_count,
    })
}

fn branches(path: &str) -> Result<Vec<BranchRef>, String> {
    let local = run(
        path,
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?;
    let remote = run(
        path,
        ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    )?;
    let mut branches = local
        .lines()
        .map(str::to_owned)
        .filter(|name| !name.is_empty())
        .map(|name| BranchRef {
            name,
            scope: "local".into(),
        })
        .collect::<Vec<_>>();
    branches.extend(
        remote
            .lines()
            .map(str::to_owned)
            .filter(|name| !name.is_empty() && !name.ends_with("/HEAD"))
            .map(|name| BranchRef {
                name,
                scope: "remote".into(),
            }),
    );
    Ok(branches)
}

fn default_base(path: &str, branches: &[BranchRef], current: Option<&str>) -> String {
    let names = branches
        .iter()
        .map(|branch| branch.name.as_str())
        .collect::<Vec<_>>();
    let remote_default = run(
        path,
        [
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .ok()
    .map(|name| name.trim().to_string());
    remote_default
        .filter(|name| names.contains(&name.as_str()))
        .or_else(|| {
            ["main", "master"]
                .iter()
                .find(|name| names.contains(name))
                .map(|name| (*name).to_string())
        })
        .or_else(|| {
            names
                .iter()
                .find(|branch| Some(**branch) != current)
                .map(|branch| (*branch).to_string())
        })
        .unwrap_or_else(|| names[0].to_string())
}

fn checkout_file(path: &str, file_path: &str) -> Result<Vec<u8>, String> {
    let root =
        fs::canonicalize(path).map_err(|error| format!("Could not read repository: {error}"))?;
    let target = root.join(file_path);
    let target = fs::canonicalize(target)
        .map_err(|error| format!("Could not read working file: {error}"))?;
    if !target.starts_with(&root) {
        return Err("Working file is outside this repository.".into());
    }
    fs::read(target).map_err(|error| format!("Could not read working file: {error}"))
}

fn run<const N: usize>(path: &str, args: [&str; N]) -> Result<String, String> {
    let output = command(path, args)?
        .output()
        .map_err(|error| format!("Could not run Git: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(git_error(&output.stderr))
    }
}

fn run_bytes<const N: usize>(path: &str, args: [&str; N]) -> Result<Vec<u8>, String> {
    let output = command(path, args)?
        .output()
        .map_err(|error| format!("Could not run Git: {error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(git_error(&output.stderr))
    }
}

fn command<const N: usize>(path: &str, args: [&str; N]) -> Result<Command, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err("Choose a folder containing a Git repository.".into());
    }
    let mut command = Command::new("git");
    command.current_dir(root).args(args);
    Ok(command)
}

fn git_error(stderr: &[u8]) -> String {
    let message = String::from_utf8_lossy(stderr).trim().to_string();
    if message.is_empty() {
        "Git could not complete that request.".into()
    } else {
        message
    }
}

fn parse_name_status(bytes: &[u8]) -> Vec<ChangedFile> {
    let fields: Vec<&[u8]> = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let status = String::from_utf8_lossy(fields[index]).into_owned();
        index += 1;
        if status.starts_with('R') || status.starts_with('C') {
            if index + 1 >= fields.len() {
                break;
            }
            let previous_path = String::from_utf8_lossy(fields[index]).into_owned();
            let path = String::from_utf8_lossy(fields[index + 1]).into_owned();
            files.push(ChangedFile {
                status: status.chars().next().unwrap_or('R').to_string(),
                path,
                previous_path: Some(previous_path),
            });
            index += 2;
        } else if let Some(raw_path) = fields.get(index) {
            files.push(ChangedFile {
                status: status.chars().next().unwrap_or('M').to_string(),
                path: String::from_utf8_lossy(raw_path).into_owned(),
                previous_path: None,
            });
            index += 1;
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::{
        LOCAL_CHECKOUT, compare, file_contents, file_diff, open_repository, parse_name_status,
    };
    use std::{
        fs,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn parses_ordinary_and_renamed_files() {
        let input = b"M\0src/app.rs\0A\0src/new.rs\0R100\0old/name.rs\0new/name.rs\0";
        let files = parse_name_status(input);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "M");
        assert_eq!(files[2].previous_path.as_deref(), Some("old/name.rs"));
        assert_eq!(files[2].path, "new/name.rs");
    }

    #[test]
    fn compares_real_branches_and_reads_a_file_diff() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("diffie-test-{suffix}"));
        fs::create_dir_all(&directory).unwrap();
        git(&directory, ["init", "-b", "main"]);
        git(&directory, ["config", "user.email", "test@diffie.local"]);
        git(&directory, ["config", "user.name", "Diffie Test"]);
        fs::write(directory.join("note.txt"), "first line\n").unwrap();
        git(&directory, ["add", "."]);
        git(&directory, ["commit", "-m", "initial"]);
        git(&directory, ["checkout", "-b", "feature"]);
        fs::write(directory.join("note.txt"), "changed line\n").unwrap();
        fs::write(directory.join("new.txt"), "new file\n").unwrap();
        git(&directory, ["add", "."]);
        git(&directory, ["commit", "-m", "feature"]);

        let root = directory.to_string_lossy();
        let repository = open_repository(&root).unwrap();
        assert_eq!(repository.current_branch.as_deref(), Some("feature"));
        assert!(
            repository
                .branches
                .iter()
                .any(|branch| branch.name == "main" && branch.scope == "local")
        );

        let comparison = compare(&root, "main", "feature").unwrap();
        assert_eq!(comparison.files.len(), 2);
        assert!(
            comparison
                .files
                .iter()
                .any(|file| file.path == "new.txt" && file.status == "A")
        );
        let diff = file_diff(&root, "main", "feature", "note.txt").unwrap();
        assert!(diff.diff.contains("-first line"));
        assert!(diff.diff.contains("+changed line"));
        let contents = file_contents(&root, "feature", "note.txt").unwrap();
        assert_eq!(contents.content, "changed line\n");
        fs::write(directory.join("note.txt"), "working copy\n").unwrap();
        let checkout_comparison = compare(&root, "main", LOCAL_CHECKOUT).unwrap();
        assert!(
            checkout_comparison
                .files
                .iter()
                .any(|file| file.path == "note.txt")
        );
        let checkout_contents = file_contents(&root, LOCAL_CHECKOUT, "note.txt").unwrap();
        assert_eq!(checkout_contents.content, "working copy\n");
        fs::remove_dir_all(directory).unwrap();
    }

    fn git<const N: usize>(directory: &std::path::Path, args: [&str; N]) {
        let status = Command::new("git")
            .current_dir(directory)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success());
    }
}
