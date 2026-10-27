//! Shared frontmatter parsing for installation and notebook skill discovery.

pub(crate) fn parse(markdown: &str) -> Result<(serde_yaml::Mapping, String), String> {
    let normalized = markdown
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n");
    let mut lines = normalized.split_inclusive('\n');
    let first = lines.next().ok_or("Skill entry file is empty")?;
    if first.trim_end() != "---" {
        return Err("Skill entry file has invalid frontmatter".into());
    }
    let mut offset = first.len();
    let start = offset;
    for line in lines {
        if line.trim_end() == "---" {
            let header = serde_yaml::from_str(&normalized[start..offset])
                .map_err(|error| format!("Skill entry file has invalid YAML: {error}"))?;
            let body = normalized[offset + line.len()..].trim().to_string();
            return Ok((header, body));
        }
        offset += line.len();
    }
    Err("Skill entry file has unclosed frontmatter".into())
}

/// Pi's compatibility copy changes the command name, never the upstream file.
pub(crate) fn render_with_name(markdown: &str, command_name: &str) -> Result<Vec<u8>, String> {
    let (mut header, body) = parse(markdown)
        .unwrap_or_else(|_| (serde_yaml::Mapping::new(), markdown.replace("\r\n", "\n")));
    header.insert("name".into(), command_name.into());
    let yaml = serde_yaml::to_string(&header).map_err(|error| error.to_string())?;
    Ok(format!("---\n{yaml}---\n{body}").into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_crlf_comments_quoted_names_and_multiline_descriptions() {
        let (header, body) = parse("---\r\nname: 'example' # comment\r\ndescription: >-\r\n  One\r\n  description\r\n---\r\n\r\nInstructions").unwrap();
        assert_eq!(header["name"].as_str(), Some("example"));
        assert_eq!(header["description"].as_str(), Some("One description"));
        assert_eq!(body, "Instructions");
    }

    #[test]
    fn accepts_closing_delimiter_at_eof_and_rejects_malformed_yaml() {
        assert!(parse("---\nname: example\n---").is_ok());
        assert!(parse("---\nname: [broken\n---\n").is_err());
        assert!(parse("---\nname: example\n").is_err());
    }

    #[test]
    fn runtime_copy_uses_the_same_parser_and_preserves_yaml_fields_at_eof() {
        let bytes = render_with_name(
            "---\r\nname: '旧名称'\r\ndescription: >-\r\n  Several\r\n  lines\r\n---",
            "example",
        )
        .unwrap();
        let (header, body) = parse(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert_eq!(header["name"].as_str(), Some("example"));
        assert_eq!(header["description"].as_str(), Some("Several lines"));
        assert!(body.is_empty());
    }
}
