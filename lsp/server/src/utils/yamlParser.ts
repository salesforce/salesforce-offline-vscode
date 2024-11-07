import { parse } from 'yaml';

export function transformYamlToObject(
    yamlContent: string,
    designatedLevelProperty: string
): Record<string, string[]> {
    // Parse the YAML content
    const parsedYaml = parse(yamlContent);

    // Check if the designated level("values") property exists
    if (!(designatedLevelProperty in parsedYaml)) {
        throw new Error(
            `Designated level property "${designatedLevelProperty}" not found in the YAML.`
        );
    }

    const result: Record<string, string[]> = {};

    // Access the designated level property
    const designatedLevel = parsedYaml[designatedLevelProperty];

    // Loop through the second-level properties
    for (const [key, value] of Object.entries(designatedLevel)) {
        // Ensure the value is an array (in YAML these arrays are represented with '-')
        if (
            Array.isArray(value) &&
            value.every((item) => typeof item === 'string')
        ) {
            result[key] = value;
        } else {
            throw new Error(
                `The property "${key}" does not contain an array of strings.`
            );
        }
    }

    return result;
}
