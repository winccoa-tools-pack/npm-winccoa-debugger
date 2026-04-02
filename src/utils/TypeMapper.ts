/**
 * TypeMapper
 *
 * Maps WinCC OA CTRL types to VS Code debugger representations.
 *
 * Responsibilities:
 * - Convert WinCC OA type names to display strings
 * - Map primitive types
 * - Handle complex types (arrays, mappings, classes)
 * - Format values for display
 *
 * WinCC OA Types:
 * - Primitives: int, uint, float, double, bool, char, string, time, bit32, bit64
 * - Arrays: dyn_int, dyn_string, dyn_float, etc.
 * - Structures: mapping, class, anytype
 * - Special: dpIdentifier, langString, errClass
 */

export class TypeMapper {
    /**
     * Map WinCC OA type to display string
     */
    public static mapType(wcType: string): string {
        // Primitive types
        const primitiveMap: Record<string, string> = {
            int: 'int',
            uint: 'uint',
            float: 'float',
            double: 'double',
            bool: 'bool',
            char: 'char',
            string: 'string',
            time: 'time',
            bit32: 'bit32',
            bit64: 'bit64',
            anytype: 'any',
        };

        if (wcType in primitiveMap) {
            return primitiveMap[wcType];
        }

        // Array types (dyn_*)
        if (wcType.startsWith('dyn_')) {
            const elementType = wcType.substring(4);
            const mappedElement = this.mapType(elementType);
            return `${mappedElement}[]`;
        }

        // Mapping
        if (wcType === 'mapping') {
            return 'mapping';
        }

        // Class types
        if (wcType.startsWith('class ')) {
            return wcType;
        }

        // Special types
        const specialMap: Record<string, string> = {
            dpIdentifier: 'dpIdentifier',
            langString: 'langString',
            errClass: 'errClass',
            shape: 'shape',
            blob: 'blob',
        };

        if (wcType in specialMap) {
            return specialMap[wcType];
        }

        // Unknown type
        return wcType;
    }

    /**
     * Format value for display
     */
    public static formatValue(value: any, type: string): string {
        if (value === null || value === undefined) {
            return 'null';
        }

        // String values
        if (type === 'string' || type === 'char') {
            return `"${value}"`;
        }

        // Boolean values
        if (type === 'bool') {
            return value ? 'true' : 'false';
        }

        // Time values
        if (type === 'time') {
            // TODO: Format time properly
            return String(value);
        }

        // Array values
        if (type.endsWith('[]')) {
            if (Array.isArray(value)) {
                return `[${value.length} items]`;
            }
            return '[]';
        }

        // Mapping values
        if (type === 'mapping') {
            if (typeof value === 'object') {
                const keys = Object.keys(value);
                return `{${keys.length} items}`;
            }
            return '{}';
        }

        // Class instances
        if (type.startsWith('class ')) {
            return `{${type}}`;
        }

        // Default: convert to string
        return String(value);
    }

    /**
     * Check if type is expandable (has children)
     */
    public static isExpandable(type: string): boolean {
        return type.endsWith('[]') || type === 'mapping' || type.startsWith('class ');
    }

    /**
     * Get element type of an array
     */
    public static getArrayElementType(type: string): string | null {
        if (type.endsWith('[]')) {
            return type.substring(0, type.length - 2);
        }
        return null;
    }
}
