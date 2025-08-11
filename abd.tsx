import type { SecurityWarning } from '../../utils/workflows/workflowSecurity'
import type {
  FilenameValidationError,
  ValidationError,
} from '../../utils/workflows/workflowValidation'
import { yaml } from '@codemirror/lang-yaml'
import { linter, lintGutter } from '@codemirror/lint'
import CodeMirror from '@uiw/react-codemirror'
import Ajv from 'ajv'
import * as jsyaml from 'js-yaml'
import * as _ from 'lodash'
import { AlertCircleIcon, CheckCircleIcon, PencilIcon } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import * as React from 'react'
import { stringify } from 'yaml'
import { Card, CardContent } from '../../components/data-display/Card'
import { Alert, AlertDescription } from '../../components/elements/Alert'
import { Button } from '../../components/elements/Button'
import { Input } from '../../components/elements/Input'
import { workflowSchema } from '../../config/workflows/workflow-schema'
import { useConfigStore } from '../../stores/config-store'
import { useGithubStore } from '../../stores/github-store'
import { logger } from '../../utils/logger'
import { configToYaml, getPreferredSecurityJobName, validateYaml, yamlToConfig } from '../../utils/utils'
import { extractAdditionalYamlData, generateDefaultFilename } from '../../utils/workflows/workflowEditorUtils'
import { getSecurityWarnings } from '../../utils/workflows/workflowSecurity'
import { combinedLinter, getYamlErrors, suggestFilenameCorrection, validateWorkflowFilename } from '../../utils/workflows/workflowValidation'
import { ValidationDialog } from './validationDialog'

/**
 * Props for the WorkflowEditor component.
 * @property onNext - Callback for next step navigation
 * @property onPrevious - Callback for previous step navigation
 * @property onValidationChange - Callback for validation state changes
 */
interface WorkflowEditorProps {
  onNext?: () => void
  onPrevious?: () => void
  onValidationChange?: (isValid: boolean) => void
}

/**
 * WorkflowEditor component
 *
 * Provides a YAML editor for workflow configuration, with validation and error handling.
 * Allows users to edit, save, and validate workflow content with security warnings.
 *
 * @param {WorkflowEditorProps} props - Props for the workflow editor component
 */
export interface WorkflowEditorHandle {
  save: () => boolean
}

/**
 * WorkflowEditor component
 *
 * Provides a YAML editor for workflow configuration, with validation and error handling.
 * Allows users to edit, save, and validate workflow content with security warnings.
 *
 * @param {WorkflowEditorProps} props - Props for the workflow editor component
 */
export const WorkflowEditor = forwardRef<WorkflowEditorHandle, WorkflowEditorProps>(
  ({ onValidationChange }, ref) => {
    const [isEditing, setIsEditing] = useState(false)
    const [showDialog, setShowDialog] = useState(false)
    const [tempContent, setTempContent] = useState('')
    const [validationErrors, setValidationErrors] = useState<ValidationError[]>([])
    const [securityWarnings, setSecurityWarnings] = useState<SecurityWarning[]>([])
    const [filenameErrors, setFilenameErrors] = useState<FilenameValidationError[]>([])
    const [lastValidContent, setLastValidContent] = useState('')
    const [isConfigUpdating, setIsConfigUpdating] = useState(false)
    const [_hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
    const [showFilenameSuggestion, setShowFilenameSuggestion] = useState(false)

    const [validMessage] = useState('YAML file is properly formatted and valid')
    const [errorMessage] = useState('')

    const [validationErrorsLength, setValidationErrorsLength] = useState(0)

    const {
      config,
      deepUpdateConfig,
      additionalYamlData,
      setAdditionalYamlData,
    } = useConfigStore()
    const { setFilename, setWorkflowContent, getFilename } = useGithubStore()
    const DEFAULT_FILENAME = 'workflow.yml'
    const [filename, setLocalFilename] = useState(() => getFilename())

    const ajvValidate = useMemo(() => {
      const ajv = new Ajv({
        allErrors: true,
        verbose: true,
        strict: false,
      })
      return ajv.compile(workflowSchema)
    }, [])

    // Validate filename whenever it changes
    useEffect(() => {
      if (filename) {
        const errors = validateWorkflowFilename(filename)
        setFilenameErrors(errors)

        // Show suggestion if there are errors
        if (errors.length > 0) {
          setShowFilenameSuggestion(true)
        }
        else {
          setShowFilenameSuggestion(false)
        }
      }
    }, [filename])

    // Notify parent component about validation status changes
    useEffect(() => {
      // Determine if there are any YAML, security, or filename errors
      const hasYamlErrors = validationErrors.length > 0
      const hasSecurityErrors = securityWarnings.some(w => w.severity === 'error')
      const hasFilenameErrors = filenameErrors.length > 0
      // Consider valid if no errors of any type
      const isValid = !hasYamlErrors && !hasSecurityErrors && !hasFilenameErrors

      // Notify parent via callback
      onValidationChange?.(isValid)
      setValidationErrorsLength(validationErrors.length)
    }, [validationErrors.length, securityWarnings.length, filenameErrors.length, onValidationChange])

    /**
     * Validate the YAML content and update error/warning state.
     * @param content - The YAML string to validate.
     * @returns True if valid, false if errors/warnings present.
     */
    const validateContent = useCallback((content: string) => {
      const errors = getYamlErrors(content).filter(e => e.severity === 'error')
      const warnings = getSecurityWarnings(content)

      setValidationErrors(errors)
      setSecurityWarnings(warnings)

      return errors.length === 0 && warnings.filter(w => w.severity === 'error').length === 0
    }, [])

    /**
     * Merge the config and additional YAML data, then update editor state.
     */
    const getMergedContent = useCallback(() => {
      // Convert config to YAML string
      const yamlContent = configToYaml(config)
      // Parse YAML to JS object
      const yamlConfigObj = jsyaml.load(yamlContent) as Record<string, unknown>
      const prevYamlContent = useGithubStore.getState().getWorkflowContent()
      const prevContent = jsyaml.load(prevYamlContent) as Record<string, unknown>

      // Handle job replacement to prevent duplicate jobs
      let yamlMerge: Record<string, unknown>
      if (prevContent?.jobs && yamlConfigObj?.jobs) {
        const prevJobs = prevContent.jobs as Record<string, unknown>
        const newJobs = yamlConfigObj.jobs as Record<string, unknown>
        const prevSecurityJobName = getPreferredSecurityJobName(prevYamlContent)
        const newSecurityJobName = Object.keys(newJobs).length > 0 ? Object.keys(newJobs)[0] : config.platform
        const mergedJobs = { ...prevJobs }

        // If we found a previous security job, update it with new configuration
        if (prevSecurityJobName) {
          const existingJob = mergedJobs[prevSecurityJobName] as Record<string, unknown>
          const newJob = newJobs[newSecurityJobName] as Record<string, unknown>
          if (prevSecurityJobName !== newSecurityJobName && existingJob) {
            // Preserve user's job name but update the job content with new config
            mergedJobs[prevSecurityJobName] = {
              ...existingJob,
              ...newJob,
              // Preserve any user modifications to runs-on, env, etc.
              'runs-on': existingJob['runs-on'] || newJob['runs-on'],
              'env': { ...(newJob.env as Record<string, unknown> || {}), ...(existingJob.env as Record<string, unknown> || {}) },
            }
          }
          else {
            // Job name hasn't changed, just update the configuration
            mergedJobs[prevSecurityJobName] = {
              ...existingJob,
              ...newJob,
              'runs-on': existingJob['runs-on'] || newJob['runs-on'],
              'env': { ...(newJob.env as Record<string, unknown> || {}), ...(existingJob.env as Record<string, unknown> || {}) },
            }
          }
        }
        else {
          // No previous security job found, add the new one
          if (newSecurityJobName) {
            mergedJobs[newSecurityJobName] = newJobs[newSecurityJobName]
          }
        }

        // Merge everything else except jobs
        yamlMerge = _.merge({}, prevContent, yamlConfigObj)
        yamlMerge.jobs = mergedJobs
      }
      else {
        yamlMerge = _.merge({}, prevContent, yamlConfigObj)
      }

      // Helper function to check if github_token is needed
      const requiresGithubToken = (cfg: any) => {
        if (!cfg?.postScanOptions)
          return false
        const {
          decoratePullRequests,
          fixPullRequests,
          createSarifFile,
          uploadToGithub,
        } = cfg.postScanOptions
        return !!(decoratePullRequests || fixPullRequests || createSarifFile || uploadToGithub)
      }

      // Store fields that were false/failure for commenting
      const disabledFields: Array<{ path: string[], key: string, value: any }> = []

      const refactorMerge = (obj: any, path: string[] = []): any =>
        Array.isArray(obj)
          ? obj
              .map((item, index) => refactorMerge(item, [...path, index.toString()]))
              .filter(item => !(Array.isArray(item) && item.length === 0) && !(typeof item === 'object' && item && Object.keys(item).length === 0))
          : obj && typeof obj === 'object'
            ? (Object.entries(obj).forEach(([k, v]) => {
                // Remove false, 'failure', and empty objects/arrays
                if (v === false || v === 'failure') {
                  disabledFields.push({ path: [...path], key: k, value: v })
                  delete obj[k]
                }
                else if (
                  (typeof v === 'object' && v && Object.keys(v).length === 0 && k !== 'workflow_dispatch')
                  || (Array.isArray(v) && v.length === 0)
                ) {
                  delete obj[k]
                }
                else if (k === 'github_token' && !requiresGithubToken(config)) {
                  disabledFields.push({ path: [...path], key: k, value: v })
                  delete obj[k]
                }
                else {
                  obj[k] = refactorMerge(v, [...path, k])
                }
              }), obj)
            : obj

      // Function to add comments for disabled fields
      const addComments = (yamlString: string) => {
        const lines = yamlString.split('\n')

        // Group disabled fields by their parent path
        const fieldsByPath = disabledFields.reduce((acc, field) => {
          const pathKey = field.path.join('.')
          if (!acc[pathKey])
            acc[pathKey] = []
          acc[pathKey].push(field)
          return acc
        }, {} as Record<string, typeof disabledFields>)

        // Process each group of disabled fields
        Object.entries(fieldsByPath).forEach(([pathKey, fields]) => {
          if (pathKey.includes('with')) {
            // Find the 'with' block and its indentation
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]
              if (line.includes('with:')) {
                // Find the indentation of fields in the with block
                let withBlockIndent = ''
                let withBlockEnd = i + 1

                // Look for the first field in the with block to get proper indentation
                while (withBlockEnd < lines.length) {
                  const nextLine = lines[withBlockEnd]
                  if (nextLine.trim() === '') {
                    withBlockEnd++
                    continue
                  }

                  // line that's not indented more than 'with:', we're done with the block
                  const withIndent = line.match(/^(\s*)/)?.[1] || ''
                  const nextIndent = nextLine.match(/^(\s*)/)?.[1] || ''

                  if (nextIndent.length <= withIndent.length && nextLine.trim() !== '') {
                    break
                  }

                  // line has content and is properly indented, use its indentation
                  if (nextLine.includes(':') && nextIndent.length > withIndent.length) {
                    withBlockIndent = nextIndent
                    withBlockEnd++
                    continue
                  }

                  withBlockEnd++
                }

                // find proper indentation from existing fields, calculate it
                if (!withBlockIndent) {
                  const withIndent = line.match(/^(\s*)/)?.[1] || ''
                  withBlockIndent = `${withIndent}  `
                }

                // Add comments at the end of the with block
                const comments = fields.map(field =>
                  `${withBlockIndent}# ${field.key}: ${field.value}`,
                ).join('\n')

                // Insert comments before the line that ends the with block
                lines.splice(withBlockEnd, 0, comments)
                break
              }
            }
          }
        })

        return lines.join('\n')
      }

      // Merge additional YAML data if available
      let mergedYaml = stringify(refactorMerge(yamlMerge), {
        lineWidth: -1,
      }).replace(/(['"])on\1/g, 'on')

      // Add comments for disabled fields
      mergedYaml = addComments(mergedYaml)

      // Update editor and validation state
      setTempContent(mergedYaml)
      setLastValidContent(mergedYaml)
      setWorkflowContent(mergedYaml)
      validateContent(mergedYaml)
    }, [config, additionalYamlData, setWorkflowContent, validateContent])

    /**
     * Refresh additional YAML data from current editor content
     */
    const refreshAdditionalData = useCallback(() => {
      if (tempContent) {
        try {
          const freshAdditionalData = extractAdditionalYamlData(tempContent, config)
          setAdditionalYamlData(freshAdditionalData)
          logger.debug('WorkflowEditor', 'Refreshed additional YAML data:', freshAdditionalData)
        }
        catch (error) {
          logger.debug('WorkflowEditor', 'Could not refresh additional data:', error)
        }
      }
    }, [tempContent, config, setAdditionalYamlData])

    // Update filename when platform changes
    useEffect(() => {
      // Generate a new default filename when the platform changes
      const newFilename = generateDefaultFilename(config.platform, DEFAULT_FILENAME)
      setFilename(newFilename)
      setLocalFilename(newFilename)
    }, [config.platform, setFilename])

    useEffect(() => {
      if (!getFilename()) {
        setFilename(DEFAULT_FILENAME)
        setLocalFilename(DEFAULT_FILENAME)
      }
    }, [getFilename, setFilename])

    useEffect(() => {
      if (isConfigUpdating) {
        setIsConfigUpdating(false)
        return
      }
      if (!isEditing) {
        logger.debug('WorkflowEditor', 'Config changed, updating workflow content')
        getMergedContent()
      }
    }, [config, isConfigUpdating, isEditing, getMergedContent])

    // Separate effect to handle additional data refresh when config changes during editing
    useEffect(() => {
      if (!isConfigUpdating && isEditing && tempContent) {
        logger.debug('WorkflowEditor', 'Config changed while editing, refreshing additional data')
        refreshAdditionalData()
      }
    }, [config, isConfigUpdating, isEditing, tempContent, refreshAdditionalData])

    const handleEdit = useCallback(() => {
      setIsEditing(true)
      getMergedContent()
    }, [getMergedContent])

    const handleContentChange = useCallback((value: string | undefined) => {
      if (value !== undefined) {
        setTempContent(value)
        validateContent(value)
        setHasUnsavedChanges(true)

        // Try to extract config and additional data
        const yamlConfig = yamlToConfig(value)
        if (yamlConfig && validateYaml(value)) {
          setIsConfigUpdating(true)
          deepUpdateConfig(yamlConfig)

          // Extract and store additional YAML data that can't be mapped to config
          const additionalData = extractAdditionalYamlData(value, yamlConfig)
          if (Object.keys(additionalData).length > 0) {
            setAdditionalYamlData(additionalData)
            logger.debug('WorkflowEditor', 'Stored additional YAML data:', additionalData)
          }

          setLastValidContent(value)
        }
      }
    }, [setWorkflowContent, validateContent, deepUpdateConfig, setAdditionalYamlData])

    const handleFilenameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value?.trim() || DEFAULT_FILENAME
      setFilename(value)
      setLocalFilename(value)
      const fileNameElement = document.getElementById('workflowFileName')
      if (fileNameElement)
        fileNameElement.textContent = value
      logger.debug('WorkflowEditor', 'Filename updated', { filename: value })
    }, [setFilename])

    const handleFilenameBlur = useCallback(() => {
      // Validate filename on blur
      if (filename) {
        const errors = validateWorkflowFilename(filename)
        setFilenameErrors(errors)

        if (errors.length > 0) {
          setShowFilenameSuggestion(true)
        }
      }
    }, [filename])

    const applySuggestedFilename = useCallback(() => {
      const suggested = suggestFilenameCorrection(filename)
      setFilename(suggested)
      setLocalFilename(suggested)
      setShowFilenameSuggestion(false)

      const fileNameElement = document.getElementById('workflowFileName')
      if (fileNameElement)
        fileNameElement.textContent = suggested

      logger.debug('WorkflowEditor', 'Applied suggested filename', {
        original: filename,
        suggested,
      })
    }, [filename, setFilename])

    const handleContinue = useCallback(() => {
      setShowDialog(false)
      logger.debug('WorkflowEditor', 'Dialog closed - continuing with current content')
    }, [])

    const handleCancel = useCallback(() => {
      setShowDialog(false)
      setTempContent(lastValidContent)
      setWorkflowContent(lastValidContent)
      validateContent(lastValidContent)

      // Restore config and additional data from last valid content
      const yamlConfig = yamlToConfig(lastValidContent)
      if (yamlConfig) {
        setIsConfigUpdating(true)
        deepUpdateConfig(yamlConfig)

        const additionalData = extractAdditionalYamlData(lastValidContent, yamlConfig)
        setAdditionalYamlData(additionalData)
      }
      setHasUnsavedChanges(false)
      logger.debug('WorkflowEditor', 'Dialog cancelled - reverted to last valid content')
    }, [lastValidContent, setWorkflowContent, validateContent, deepUpdateConfig, setAdditionalYamlData])

    const handleSave = useCallback(() => {
      try {
        const yamlConfig = yamlToConfig(tempContent)
        const isValid = validateYaml(tempContent)
        const hasSecurityErrors = securityWarnings.some(w => w.severity === 'error')

        if (isValid && !hasSecurityErrors) {
          setIsConfigUpdating(true)
          if (yamlConfig)
            deepUpdateConfig(yamlConfig)

          // Extract and store additional YAML data
          const additionalData = extractAdditionalYamlData(tempContent, config)
          setAdditionalYamlData(additionalData)

          setWorkflowContent(tempContent)
          setLastValidContent(tempContent)
          setIsEditing(false)
          setHasUnsavedChanges(false)
          logger.debug('WorkflowEditor', 'Workflow content saved successfully', {
            hasAdditionalData: Object.keys(additionalData).length > 0,
          })
        }
        else {
          logger.debug('WorkflowEditor', 'Invalid YAML content or security errors detected', {
            validationErrors,
            securityWarnings,
          })
          setShowDialog(true)
        }
      }
      catch (error) {
        logger.error('WorkflowEditor', 'Error saving workflow content:', error)
        setShowDialog(true)
      }
    }, [tempContent, securityWarnings, filenameErrors, deepUpdateConfig, setAdditionalYamlData, setWorkflowContent])

    // Handle dialog state changes to ensure blur is properly managed
    const handleDialogOpenChange = useCallback((open: boolean) => {
      setShowDialog(open)
      if (!open) {
        // Ensure blur is removed when dialog is closed
        logger.debug('WorkflowEditor', 'Dialog state changed to closed')
      }
    }, [])

    // Handle escape key and other dialog close scenarios
    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && showDialog) {
          handleCancel()
        }
      }

      if (showDialog) {
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
      }
    }, [showDialog, handleCancel])

    // Cleanup function to ensure blur is removed on unmount
    useEffect(() => {
      return () => {
        if (showDialog) {
          setShowDialog(false)
        }
      }
    }, [showDialog])

    useImperativeHandle(ref, () => ({
      save: () => {
        try {
          const yamlConfig = yamlToConfig(tempContent)
          const isValid = validateYaml(tempContent)
          const hasSecurityErrors = securityWarnings.some(w => w.severity === 'error')

          if (isValid && !hasSecurityErrors) {
            setIsConfigUpdating(true)
            if (yamlConfig)
              deepUpdateConfig(yamlConfig)

            // Extract and store additional YAML data
            const additionalData = extractAdditionalYamlData(tempContent, config)
            setAdditionalYamlData(additionalData)

            setWorkflowContent(tempContent)
            setLastValidContent(tempContent)
            setIsEditing(false)
            setHasUnsavedChanges(false)
            logger.debug('WorkflowEditor', 'Workflow content saved successfully via imperative handle', {
              hasAdditionalData: Object.keys(additionalData).length > 0,
            })
            return true
          }
          else {
            logger.debug('WorkflowEditor', 'Invalid YAML content or security errors detected during save', {
              validationErrors,
              securityWarnings,
            })
            setShowDialog(true)
            return false
          }
        }
        catch (error) {
          logger.error('WorkflowEditor', 'Error saving workflow content via imperative handle:', error)
          setShowDialog(true)
          return false
        }
      },
    }), [tempContent, validationErrors, securityWarnings, filenameErrors, deepUpdateConfig, setAdditionalYamlData, setWorkflowContent])

    const hasErrors = validationErrorsLength > 0
    const hasSecurityErrors = securityWarnings.some(w => w.severity === 'error')
    const hasSecurityWarnings = securityWarnings.some(w => w.severity === 'warning')
    const hasFilenameErrors = filenameErrors.length > 0
    const hasAnyIssues = hasErrors || hasSecurityErrors || hasSecurityWarnings || hasFilenameErrors

    const currentState = {
      isValid: !hasErrors,
      title: hasErrors ? 'Invalid YAML' : 'Valid YAML',
      message: hasErrors ? errorMessage : validMessage,
      icon: hasErrors ? <AlertCircleIcon className="h-4 w-4" /> : <CheckCircleIcon className="h-4 w-4" />,
    }

    return (
      <div className="workflow-container" data-cy="workflow-editor-container">
        <ValidationDialog
          open={showDialog}
          onOpenChange={handleDialogOpenChange}
          onContinue={handleContinue}
          onCancel={handleCancel}
          data-cy="workflow-editor-validation-dialog"
        />

        <div className={`workflow-content w-full transition-all duration-200 ${showDialog ? 'blur-sm pointer-events-none' : ''}`} data-cy="workflow-editor-content">
          <div className="w-full" data-cy="workflow-editor-header">
            <Card className="flex bg-white shadow-none" data-cy="workflow-editor-card">
              <CardContent className="flex flex-col items-start gap-4 relative w-full h-full p-0" data-cy="workflow-editor-card-content">
                <div className="flex items-center gap-2 relative self-stretch w-full" data-cy="workflow-editor-header-content">
                  <div className="inline-flex items-center gap-2" data-cy="workflow-editor-header-filename">
                    <h2
                      id="workflowFileName"
                      className="relative w-fit mt-[-1.00px] font-['Inter',Helvetica] font-semibold text-zinc-900 text-xl tracking-[-0.40px] leading-7 whitespace-nowrap"
                      data-cy="workflow-editor-filename-label"
                    >
                      {filename}
                    </h2>
                  </div>
                  {isEditing
                    ? (
                        <Button
                          variant="ghost"
                          size="lg"
                          className="inline-flex h-9 items-center justify-center gap-2 px-3 py-2"
                          onClick={handleSave}
                          disabled={hasErrors || hasSecurityErrors || hasFilenameErrors}
                          data-cy="workflow-editor-save-button"
                        >
                          <span className="font-text-small-leading-normal-medium text-zinc-900 text-bold" data-cy="workflow-editor-save-button-text">
                            Save
                          </span>
                        </Button>
                      )
                    : (
                        <Button
                          variant="ghost"
                          size="lg"
                          className="inline-flex h-9 items-center justify-center gap-2 px-3 py-2"
                          onClick={handleEdit}
                          data-cy="workflow-editor-edit-button"
                        >
                          <PencilIcon className="w-6 h-6" />
                          <span className="font-text-small-leading-normal-medium text-zinc-900 text-bold" data-cy="workflow-editor-edit-button-text">
                            Edit
                          </span>
                        </Button>
                      )}
                </div>

                <div className="flex flex-col flex-grow w-full overflow-hidden" data-cy="workflow-editor-textarea">
                  <div style={{ overflow: 'auto' }} data-cy="workflow-editor-textarea-1">
                    <CodeMirror
                      value={tempContent}
                      height="auto"
                      extensions={
                        isEditing
                          ? [
                              yaml(),
                              linter(combinedLinter(ajvValidate)),
                              lintGutter(),
                            ]
                          : [yaml()]
                      }
                      onChange={handleContentChange}
                      theme="light"
                      basicSetup={{ lineNumbers: true, indentWithTab: true }}
                      editable={isEditing}
                      data-cy="workflow-editor-codemirror"
                    />
                  </div>
                </div>

                {/* Validation Alerts Display */}
                {isEditing && (
                  <div className="w-full flex flex-col gap-6" data-cy="workflow-editor-validation-alerts">
                    <div className="flex flex-col gap-4" data-cy="workflow-editor-validation-alerts-container">
                      <Alert
                        variant="default"
                        className={`p-4 rounded-lg transition-all duration-200 ${
                          currentState.isValid && !hasSecurityWarnings
                            ? 'border-green-200 bg-green-50/50'
                            : hasSecurityErrors || hasErrors || hasFilenameErrors
                              ? 'border-red-200 bg-red-50/50'
                              : 'border-red-200 bg-red-50/50'
                        }`}
                        data-cy="workflow-editor-validation-alert"
                      >
                        <div className="flex w-full items-start relative" data-cy="workflow-editor-validation-alert-content">
                          <span
                            className={`absolute left-0 top-1 ${
                              currentState.isValid && !hasSecurityWarnings
                                ? 'text-green-600'
                                : hasSecurityErrors || hasErrors || hasFilenameErrors
                                  ? 'text-red-600'
                                  : 'text-red-600'
                            }`}
                            data-cy="workflow-editor-validation-icon"
                          >
                            {currentState.icon}
                          </span>
                          <div
                            className={`pl-7 font-medium text-base ${
                              currentState.isValid && !hasSecurityWarnings
                                ? 'text-green-800'
                                : hasSecurityErrors || hasErrors || hasFilenameErrors
                                  ? 'text-red-800'
                                  : 'text-red-800'
                            }`}
                            data-cy="workflow-editor-validation-title"
                            style={{
                              fontFamily:
                                'var(--text-base-leading-normal-medium-font-family)',
                              fontSize: 'var(--text-base-leading-normal-medium-font-size)',
                              letterSpacing:
                                'var(--text-base-leading-normal-medium-letter-spacing)',
                              lineHeight:
                                'var(--text-base-leading-normal-medium-line-height)',
                              fontStyle:
                                'var(--text-base-leading-normal-medium-font-style)',
                            }}
                          >
                            {currentState.title}
                          </div>
                        </div>

                        {/* Render filename validation errors */}
                        {filenameErrors.length > 0 && (
                          <div className="pl-7 mt-2">
                            <h4 className="hidden font-medium text-sm text-red-800 mb-2">Filename Validation Errors:</h4>
                            <ul className="font-mono text-sm p-2 rounded border-l-2 text-red-700 bg-red-100/50 border-red-300 space-y-1">
                              {filenameErrors.map((error, idx) => (
                                <li key={idx}>
                                  {error.message}
                                </li>
                              ))}
                            </ul>
                            {showFilenameSuggestion && (
                              <div className="hidden mt-3 p-3 bg-blue-50 border border-blue-200 rounded-md">
                                <p className="text-sm text-blue-800 mb-2">
                                  <strong>Suggested filename:</strong>
                                  {' '}
                                  {suggestFilenameCorrection(filename)}
                                </p>
                                <Button
                                  onClick={applySuggestedFilename}
                                  size="sm"
                                  className="bg-blue-600 hover:bg-blue-700 text-white text-xs"
                                >
                                  Apply Suggestion
                                </Button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Render validation errors */}
                        {validationErrors.length > 0 && (
                          <div className="pl-7 mt-2" data-cy="workflow-editor-validation-errors">
                            <h4 className="hidden font-medium text-sm text-red-800 mb-2">YAML Validation Errors:</h4>
                            <ul className="font-mono text-sm p-2 rounded border-l-2 text-red-700 bg-red-100/50 border-red-300 space-y-1" data-cy={`workflow-editor-validation-errors-list-${validationErrorsLength}`}>
                              {validationErrors.filter(e => e.severity === 'error').map((error, idx) => (
                                <li key={idx} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                  {error.line && error.column && `line:${error.line}, col:${error.column} `}
                                  {error.message}
                                  {error.path && ` [${error.path}]`}
                                  {error.type && ` [${error.type}]`}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Render security warnings */}
                        {securityWarnings.length > 0 && (
                          <div className="pl-7 mt-2">
                            <h4 className={`hidden font-medium text-sm mb-2 ${securityWarnings.some(w => w.severity === 'error') ? 'text-red-800' : 'text-yellow-800'}`}>
                              Security Issues:
                            </h4>
                            <div className="space-y-2">
                              {securityWarnings.map((warning, idx) => (
                                <div key={idx} className={`font-mono text-sm p-2 rounded border-l-2 ${warning.severity === 'error' ? 'text-red-700 bg-red-100/50 border-red-300' : 'text-yellow-700 bg-yellow-100/50 border-yellow-300'}`}>
                                  {`Line ${warning.line ?? '-'}: ${warning.message}`}
                                  {warning.field && (
                                    <div className="hidden text-xs text-gray-500">
                                      {warning.field}
                                      {warning.value && `: ${warning.value}`}
                                    </div>
                                  )}
                                </div>
                              ))}
                              {validationErrors.filter(e => e.severity === 'warning').map((error, idx) => (
                                <li key={idx} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                  {error.line && error.column && `line:${error.line}, col:${error.column} `}
                                  {error.message}
                                  {error.path && ` [${error.path}]`}
                                  {error.type && ` [${error.type}]`}
                                </li>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Only show the success message if there are no issues */}
                        {currentState.message && !hasAnyIssues && (
                          <AlertDescription
                            className="pl-7 mt-2 font-mono text-sm p-2 rounded border-l-2 text-green-700 bg-green-100/50 border-green-300"
                            style={{
                              fontFamily: 'ui-monospace, SFMono-Regular, \'SF Mono\', Consolas, \'Liberation Mono\', Menlo, monospace',
                              fontSize: '13px',
                              lineHeight: '18px',
                            }}
                            data-cy="workflow-editor-validation-success-message"
                          >
                            {currentState.message}
                          </AlertDescription>
                        )}
                      </Alert>
                    </div>
                  </div>
                )}

                <div className="flex flex-col items-start gap-2 relative self-stretch w-full mt-auto" data-cy="workflow-editor-filename-section">
                  <div className="flex items-start gap-0.5 relative self-stretch w-full" data-cy="workflow-editor-filename-label-row">
                    <label className="relative w-fit mt-[-1.00px] font-text-small-leading-none-medium text-zinc-900" data-cy="workflow-editor-filename-label">
                      *Filename
                    </label>
                  </div>
                  <div className="flex flex-col items-start gap-2 relative self-stretch w-full" data-cy="workflow-editor-filename-container">
                    <Input
                      className={`h-10 px-3 py-2 relative self-stretch w-full bg-white rounded-md border border-solid ${
                        hasFilenameErrors ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : 'border-[#888c91]'
                      }`}
                      value={filename}
                      onChange={handleFilenameChange}
                      onBlur={handleFilenameBlur}
                      placeholder="workflow.yml"
                      data-cy="workflow-editor-filename-input"
                    />
                    {hasFilenameErrors && (
                      <div className="text-xs text-red-600 mt-1" data-cy="workflow-editor-filename-error-container">
                        <p data-cy="workflow-editor-filename-error-message">
                          The GitHub workflow filename must end with a
                          {' '}
                          <code data-cy={`workflow-editor-filename-error-code-yml-${filename}`}>.yml</code>
                          {' '}
                          or
                          {' '}
                          <code data-cy={`workflow-editor-filename-error-code-yaml-${filename}`}>.yaml</code>
                          {' '}
                          extension.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    )
  },
)

WorkflowEditor.displayName = 'WorkflowEditor'
