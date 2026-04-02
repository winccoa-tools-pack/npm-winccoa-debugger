/**
 * ResponseParser
 * 
 * Parses responses from WinCC OA debugger into structured data.
 * 
 * Responsibilities:
 * - Parse JSON responses from WinCC OA
 * - Extract thread information
 * - Parse stack trace data
 * - Convert variable data to structured format
 * - Handle error responses
 * 
 * WinCC OA Response Format:
 * - Result DPE contains dyn_string array
 * - First element is command ID
 * - Following elements are result data (often JSON)
 * - Error responses have special format
 */

export interface ThreadInfo {
  threadId: number;
  scriptId: number;
  scopeId?: number;
  state: string;
  location?: string;
}

export interface StackFrameInfo {
  level: number;
  function: string;
  location: string;
  line: number;
}

export interface VariableInfo {
  name: string;
  value: string;
  type: string;
  varType: string;
}

export class ResponseParser {
  /**
   * Parse generic response
   */
  public static parseResponse(response: string[]): {
    commandId: string;
    data: string[];
  } {
    if (response.length === 0) {
      throw new Error('Empty response');
    }

    return {
      commandId: response[0],
      data: response.slice(1)
    };
  }

  /**
   * Parse thread list response
   */
  public static parseThreads(data: string[]): ThreadInfo[] {
    // TODO: Implement thread parsing
    // Parse output from "info threads" command
    return [];
  }

  /**
   * Parse stack trace response
   */
  public static parseStackTrace(data: string[]): StackFrameInfo[] {
    // TODO: Implement stack trace parsing
    // Parse output from "info stack" command
    return [];
  }

  /**
   * Parse variable list response
   */
  public static parseVariables(data: string[]): VariableInfo[] {
    // TODO: Implement variable parsing
    // Parse output from "info locals" or "info globals"
    return [];
  }

  /**
   * Parse evaluate result
   */
  public static parseEvaluateResult(data: string[]): {
    result: string;
    type?: string;
  } {
    // TODO: Implement expression result parsing
    // Parse output from "print <expr>"
    return {
      result: data.join('\n')
    };
  }

  /**
   * Check if response is an error
   */
  public static isError(data: string[]): boolean {
    // TODO: Detect error responses
    return data.some(line => line.startsWith('Error:') || line.startsWith('ERR'));
  }

  /**
   * Extract error message
   */
  public static getErrorMessage(data: string[]): string {
    // TODO: Extract error message from response
    return data.join(' ');
  }

  /**
   * Parse JSON response
   */
  public static parseJson<T = any>(jsonStr: string): T {
    try {
      return JSON.parse(jsonStr);
    } catch (error) {
      throw new Error(`Failed to parse JSON: ${error}`);
    }
  }
}
